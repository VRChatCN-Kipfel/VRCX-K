//! Host ready handshake — the Rust mirror of the versioned wire contract.
//!
//! The canonical definition is
//! `contracts/host-ready/v1/host-ready.schema.json`; this module is the
//! hand-written Rust mirror, validated against that schema by the contract test
//! at the bottom (which reads the schema with `include_str!`, exactly as
//! `host_lifecycle.rs` does).
//!
//! Why this exists as a named type rather than an ad-hoc `serde_json::Value`
//! parse in `host.rs`: the handshake is the FIRST frame the host sends and the
//! only place the shell learns how to reach the host's ws surface. Parsing it
//! structurally means a version-skewed or malformed handshake is rejected at the
//! boundary — naming the actual fault — instead of yielding a `None` port that
//! later surfaces as "host did not call ready() within 10s", which blames the
//! wrong side.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The `schemaVersion` this shell implements. A handshake carrying anything else
/// is refused rather than partially trusted.
pub const HOST_READY_SCHEMA_VERSION: u16 = 1;

/// The repo-wide JSON safe-integer ceiling. `totalMemBytes` exceeds 32 bits on
/// ordinary machines, so it is bounded by this rather than by a u32.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[allow(dead_code)]
pub const HOST_READY_SCHEMA_ID: &str =
    "https://vrcx-k.dev/contracts/host-ready/v1/host-ready.schema.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostRuntime {
    pub bun_version: String,
    pub node_version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostPlatformInfo {
    /// Operating system, using `contracts/plugin-manifest/v1`'s vocabulary
    /// (`windows`/`linux`/`macos`) rather than `process.platform`'s raw values.
    /// Held as `String` because the host normalises it before sending; the enum
    /// in the schema pins the spelling, and `is_supported` still rejects unknown
    /// values so a stray `win32` cannot slip through.
    pub platform: String,
    /// CPU architecture, likewise using plugin-manifest's names.
    pub arch: String,
    /// `source` = run from a checkout, `compiled` = the single-file sidecar.
    /// `paths.cwd` means different things in each, so consumers must read it.
    pub mode: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostPaths {
    pub cwd: String,
    pub exec_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostCapacity {
    /// Dates the snapshot. Without it a log reader would treat these as live.
    pub captured_at_ms: u64,
    pub cpu_count: u32,
    pub total_mem_bytes: u64,
}

/// The host → shell startup handshake.
///
/// `deny_unknown_fields` is what makes the schema's `additionalProperties:false`
/// true on this side. Without it serde silently ignores an unexpected key, so a
/// host and shell that disagreed about the handshake would both look fine — the
/// exact class of quiet divergence this contract exists to prevent.
///
/// SCOPE: this attribute is PER-STRUCT, and every struct in this module carries
/// its own — the four groups (`HostRuntime`, `HostPlatformInfo`, `HostPaths`,
/// `HostCapacity`) as well as this one, because the schema declares
/// `additionalProperties:false` at each of those levels too. An earlier revision
/// only had it here, which meant a stray key INSIDE `host`/`paths`/`capacity`
/// was accepted by Rust while the TS guard and the schema both rejected it. If
/// you add another nested struct, give it the attribute as well; the
/// `nested_*_rejects_unknown_keys` tests below are what fail if you forget.
///
/// `extra` is the bounded forward-compatibility slot, and it is the ONE place
/// where unknown keys are welcome. That is compatible with
/// `deny_unknown_fields` because the attribute governs a struct's own fields,
/// while `extra` is a named field holding an open map. Its bounds (≤32 entries,
/// camelCase keys, scalar values only) are enforced in `is_supported` rather
/// than by serde, since serde cannot express them for a `BTreeMap<String,
/// Value>` — see `extra_slot_*` and `extra_bounds_*` below.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostReady {
    pub schema_version: u16,
    pub port: u16,
    pub token: String,
    pub host_version: String,
    pub runtime: HostRuntime,
    pub host: HostPlatformInfo,
    pub paths: HostPaths,
    pub capacity: HostCapacity,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl HostReady {
    /// Whether the token has the shape the host promises (32 random bytes as
    /// lowercase hex). The schema pins this with a regex; enforcing it here keeps
    /// the two sides from disagreeing about what a valid token looks like.
    pub fn has_valid_token(&self) -> bool {
        self.token.len() == 64
            && self
                .token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    /// Whether this handshake is one the shell can act on.
    ///
    /// Rejects `port == 0`: the host binds an ephemeral port and reports what the
    /// OS assigned, so 0 means the bind result was lost, not "any port".
    pub fn is_supported(&self) -> bool {
        self.schema_version == HOST_READY_SCHEMA_VERSION
            && self.port != 0
            && self.has_valid_token()
            && !self.host_version.is_empty()
            && self.host_version.len() <= 64
            && matches!(self.host.platform.as_str(), "windows" | "linux" | "macos")
            && matches!(self.host.arch.as_str(), "x64" | "arm64")
            && matches!(self.host.mode.as_str(), "source" | "compiled")
            && !self.paths.cwd.is_empty()
            && !self.paths.exec_path.is_empty()
            && !self.runtime.bun_version.is_empty()
            && !self.runtime.node_version.is_empty()
            && self.capacity.cpu_count >= 1
            && self.capacity.total_mem_bytes >= 1
            && self.capacity.total_mem_bytes <= MAX_SAFE_INTEGER
            && self.has_valid_extra()
    }

    /// Whether the forward-compatibility slot respects its bounds.
    ///
    /// The schema states these (`maxProperties: 32`, a camelCase `propertyNames`
    /// rule, and scalar-only values), and `host/src/contracts/hostReady.ts`
    /// enforces them in `isExtra`. Serde CANNOT: `extra` is a
    /// `BTreeMap<String, serde_json::Value>`, so nothing about a key's spelling
    /// or a value's shape is visible to the derive. Before this method existed,
    /// Rust accepted a nested object, an array, a `bad-key`, or 40 keys while the
    /// TS guard and the schema both rejected them — and `extra` is the ONLY open
    /// surface in this contract, so leaving it unchecked undercut the entire
    /// "the open surface must stay narrow" argument.
    ///
    /// Mirrors the TS guard clause for clause; keep the two in step. The
    /// `extra_bounds_*` tests below are what fail if they drift.
    pub fn has_valid_extra(&self) -> bool {
        if self.extra.len() > MAX_EXTRA_ENTRIES {
            return false;
        }
        self.extra
            .iter()
            .all(|(key, value)| is_extra_key(key) && is_extra_value(value))
    }
}

/// Cap on the extension slot, mirroring the schema's `maxProperties: 32`.
pub const MAX_EXTRA_ENTRIES: usize = 32;

/// The extension slot's key rule: 1..=64 chars, `^[a-z][a-zA-Z0-9]*$`.
///
/// Written out rather than pulled in as a regex dependency: the pattern is tiny
/// and fixed, and `regress` is already in the tree only for typify's generated
/// regexes, not for this module's hand-written checks.
///
/// Note the ordering: the first character is consumed BEFORE the length check, so
/// an empty key fails on the `None` arm rather than needing a separate case.
/// Length is compared in bytes, which is safe because every accepted character is
/// ASCII — a non-ASCII byte fails the `is_ascii_alphanumeric` test anyway.
fn is_extra_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    key.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric())
}

/// Scalar-only value rule: null, bool, string, or a FINITE number.
///
/// `Array` and `Object` are deliberately excluded — that is the substantive part
/// of this check, because `extra` is the contract's only open surface and an
/// unbounded sub-schema there would defeat the reason the top level can stay
/// strict. The finiteness clause mirrors the TS guard's `Number.isFinite`;
/// `serde_json` cannot represent a non-finite number coming off the wire, but
/// keeping the two implementations literally equivalent means neither side can
/// drift into accepting something the other rejects.
fn is_extra_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::String(_) => true,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> HostReady {
        HostReady {
            schema_version: HOST_READY_SCHEMA_VERSION,
            port: 43120,
            token: "a".repeat(64),
            host_version: "0.0.1".into(),
            runtime: HostRuntime {
                bun_version: "1.4.2".into(),
                node_version: "v26.3.0".into(),
            },
            host: HostPlatformInfo {
                platform: "windows".into(),
                arch: "x64".into(),
                mode: "compiled".into(),
            },
            paths: HostPaths {
                cwd: "C:/app/resources".into(),
                exec_path: "C:/app/resources/host-x86_64-pc-windows-msvc.exe".into(),
            },
            capacity: HostCapacity {
                captured_at_ms: 1_760_000_000_000,
                cpu_count: 24,
                total_mem_bytes: 33_676_386_304,
            },
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn camel_case_on_the_wire_and_snake_case_in_rust() {
        let value = serde_json::to_value(valid()).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["hostVersion"], "0.0.1");
        assert_eq!(value["runtime"]["bunVersion"], "1.4.2");
        assert_eq!(value["host"]["platform"], "windows");
        assert_eq!(
            value["paths"]["execPath"],
            "C:/app/resources/host-x86_64-pc-windows-msvc.exe"
        );
        assert_eq!(value["capacity"]["totalMemBytes"], 33_676_386_304u64);
        assert!(value.get("schema_version").is_none());
        assert!(value.get("host_version").is_none());
    }

    #[test]
    fn a_supported_handshake_round_trips() {
        let ready = valid();
        assert!(ready.is_supported());
        let wire = serde_json::to_string(&ready).unwrap();
        let back: HostReady = serde_json::from_str(&wire).unwrap();
        assert_eq!(back, ready);
    }

    /// The literal frame the TypeScript host emits (captured verbatim from a real
    /// `bun run src/index.ts`; only cwd/execPath shortened), parsed by this
    /// mirror. This is the cross-LANGUAGE check: every other test here builds
    /// values in Rust, so none of them can catch the two sides disagreeing about
    /// the wire spelling. If the host renames or moves a field, this fails.
    ///
    /// Note `extra` is ABSENT — exactly what a real host sends when it has
    /// nothing to add.
    #[test]
    fn the_real_host_frame_parses_into_this_mirror() {
        let wire = concat!(
            r#"{"schemaVersion":1,"port":64050,"#,
            r#""token":"af92871c917e9ff478724e411c0e8ffbc96dd4463eb43e74d7521de2438f4089","#,
            r#""hostVersion":"0.0.1","#,
            r#""runtime":{"bunVersion":"1.4.2","nodeVersion":"v26.3.0"},"#,
            r#""host":{"platform":"windows","arch":"x64","mode":"source"},"#,
            r#""paths":{"cwd":"E:\\Users\\x\\VRCX-K\\host","execPath":"D:\\bun\\bin\\bun.exe"},"#,
            r#""capacity":{"capturedAtMs":1789920810598,"cpuCount":24,"totalMemBytes":33676386304}}"#
        );
        let ready: HostReady =
            serde_json::from_str(wire).expect("the host's real frame must parse");
        assert_eq!(ready.schema_version, HOST_READY_SCHEMA_VERSION);
        assert_eq!(ready.port, 64050);
        assert_eq!(ready.host_version, "0.0.1");
        assert_eq!(ready.runtime.bun_version, "1.4.2");
        assert_eq!(ready.runtime.node_version, "v26.3.0");
        assert_eq!(ready.host.platform, "windows");
        assert_eq!(ready.host.arch, "x64");
        assert_eq!(ready.host.mode, "source");
        assert_eq!(ready.capacity.cpu_count, 24);
        assert_eq!(ready.capacity.total_mem_bytes, 33_676_386_304);
        assert!(ready.extra.is_empty());
        assert!(ready.has_valid_token());
        assert!(ready.is_supported());
    }

    /// An unknown field is a contract violation, not something to ignore: the
    /// host and shell disagreeing about the handshake is the exact failure this
    /// contract exists to name. (`additionalProperties:false` in the schema.)
    #[test]
    fn an_unknown_top_level_field_is_rejected_rather_than_ignored() {
        let mut value = serde_json::to_value(valid()).unwrap();
        value["surprise"] = serde_json::json!(true);
        assert!(serde_json::from_value::<HostReady>(value).is_err());
    }

    /// Strictness is per-struct, so every GROUP needs covering too — the schema
    /// says `additionalProperties:false` at each of these levels, and an earlier
    /// revision only enforced it at the top. Each case below failed before the
    /// four nested `deny_unknown_fields` attributes were added.
    ///
    /// One test per group, so a regression names which struct lost it.
    #[test]
    fn nested_runtime_rejects_unknown_keys() {
        let mut value = serde_json::to_value(valid()).unwrap();
        value["runtime"]["surprise"] = serde_json::json!(true);
        assert!(serde_json::from_value::<HostReady>(value).is_err());
    }

    #[test]
    fn nested_host_rejects_unknown_keys() {
        let mut value = serde_json::to_value(valid()).unwrap();
        value["host"]["surprise"] = serde_json::json!(true);
        assert!(serde_json::from_value::<HostReady>(value).is_err());
    }

    #[test]
    fn nested_paths_rejects_unknown_keys() {
        let mut value = serde_json::to_value(valid()).unwrap();
        value["paths"]["surprise"] = serde_json::json!(true);
        assert!(serde_json::from_value::<HostReady>(value).is_err());
    }

    #[test]
    fn nested_capacity_rejects_unknown_keys() {
        let mut value = serde_json::to_value(valid()).unwrap();
        value["capacity"]["surprise"] = serde_json::json!(true);
        assert!(serde_json::from_value::<HostReady>(value).is_err());
    }

    /// The forward-compatibility slot accepts arbitrary scalar keys — this is the
    /// property that lets a future addition travel without a schema-version bump.
    /// It coexists with `deny_unknown_fields` because that attribute governs the
    /// top level, while `extra` is a NAMED field with an open value map.
    #[test]
    fn extra_slot_accepts_arbitrary_scalar_keys() {
        let value = serde_json::json!({
            "schemaVersion": 1, "port": 43120, "token": "a".repeat(64), "hostVersion": "0.0.1",
            "runtime": {"bunVersion": "1.4.2", "nodeVersion": "v26.3.0"},
            "host": {"platform": "windows", "arch": "x64", "mode": "source"},
            "paths": {"cwd": "/a", "execPath": "/b/bun"},
            "capacity": {"capturedAtMs": 1, "cpuCount": 1, "totalMemBytes": 1},
            "extra": {"buildId": "abc123", "betaChannel": true, "probeScore": 0.5, "nothing": null}
        });
        let ready: HostReady = serde_json::from_value(value).expect("extra keys must be accepted");
        assert_eq!(ready.extra.len(), 4);
        assert!(ready.is_supported());
    }

    /// An empty/absent `extra` is legal: its absence means "nothing extra", not
    /// "malformed". This is what keeps the slot additive.
    #[test]
    fn extra_slot_is_optional() {
        let mut value = serde_json::to_value(valid()).unwrap();
        value.as_object_mut().unwrap().remove("extra");
        let ready: HostReady = serde_json::from_value(value).expect("absent extra must parse");
        assert!(ready.extra.is_empty());
        // Absent extra must still be a USABLE handshake, not merely parseable.
        assert!(ready.is_supported());
    }

    /// These are the bounds serde cannot express. Before `has_valid_extra`
    /// existed, EVERY case below was accepted by Rust while the schema and the TS
    /// guard both rejected it — a producer-drift check that silently did not check
    /// the one open surface in the contract.
    #[test]
    fn extra_bounds_reject_more_than_32_entries() {
        let mut ready = valid();
        for i in 0..=MAX_EXTRA_ENTRIES {
            ready.extra.insert(format!("k{i}"), serde_json::json!(1));
        }
        assert_eq!(ready.extra.len(), MAX_EXTRA_ENTRIES + 1);
        assert!(
            !ready.is_supported(),
            "33 entries must exceed maxProperties: 32"
        );
        // Exactly at the cap is still fine — the bound is inclusive.
        ready.extra.remove(&format!("k{MAX_EXTRA_ENTRIES}"));
        assert_eq!(ready.extra.len(), MAX_EXTRA_ENTRIES);
        assert!(
            ready.is_supported(),
            "32 entries is at the cap, not over it"
        );
    }

    #[test]
    fn extra_bounds_reject_non_camel_case_keys() {
        for bad in ["bad-key", "Bad", "_x", "1abc", ""] {
            let mut ready = valid();
            ready.extra.insert(bad.into(), serde_json::json!(1));
            assert!(!ready.is_supported(), "key {bad:?} must be rejected");
        }
        // A >64-char key is out of range too.
        let mut ready = valid();
        ready.extra.insert("a".repeat(65), serde_json::json!(1));
        assert!(!ready.is_supported());
        // ...but a 64-char one is exactly at the limit.
        let mut ready = valid();
        ready.extra.insert("a".repeat(64), serde_json::json!(1));
        assert!(ready.is_supported());
    }

    /// The substantive one: `extra` is an open EXTENSION POINT, not an unbounded
    /// sub-schema. Structure must be promoted to a named field instead of being
    /// smuggled through here.
    #[test]
    fn extra_bounds_reject_structured_values() {
        let mut ready = valid();
        ready
            .extra
            .insert("nested".into(), serde_json::json!({"deep": true}));
        assert!(!ready.is_supported(), "a nested object must be rejected");

        let mut ready = valid();
        ready.extra.insert("list".into(), serde_json::json!([1, 2]));
        assert!(!ready.is_supported(), "an array must be rejected");

        // Every scalar form stays welcome.
        for ok in [
            serde_json::json!(null),
            serde_json::json!(true),
            serde_json::json!("s"),
            serde_json::json!(1),
            serde_json::json!(0.5),
            serde_json::json!(-3),
        ] {
            let mut ready = valid();
            ready.extra.insert("value".into(), ok.clone());
            assert!(ready.is_supported(), "scalar {ok} must be accepted");
        }
    }

    /// The shared corpus, driven through BOTH guards.
    ///
    /// This file is read by this test AND by
    /// `host/tests/host-ready-contract.test.ts`. Testing each side against its own
    /// hand-written table is what let the two disagree in the first place — Rust
    /// accepted nested objects, arrays, bad keys and oversized maps while the TS
    /// guard and the schema rejected them. One corpus, both readers, so a drift
    /// fails on whichever side moved.
    #[test]
    fn guard_parity_corpus_matches_this_mirror() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../contracts/host-ready/v1/guard-parity.corpus.json"
        ))
        .unwrap();

        // The corpus's cap must match the schema's `maxProperties`, or the fixture
        // itself would be asserting a stale bound.
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../contracts/host-ready/v1/host-ready.schema.json"
        ))
        .unwrap();
        assert_eq!(
            corpus["maxProperties"], schema["properties"]["extra"]["maxProperties"],
            "corpus and schema disagree about maxProperties"
        );

        let cases = corpus["cases"].as_array().expect("cases must be an array");
        assert!(!cases.is_empty(), "corpus must not be empty");

        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            let expect = case["expect"].as_bool().expect("expect must be a bool");

            // Go through the WIRE rather than building the map directly, so this
            // exercises what actually arrives over stdio.
            let mut payload = serde_json::to_value(valid()).unwrap();
            payload["extra"] = case["extra"].clone();

            let got = match serde_json::from_value::<HostReady>(payload) {
                Ok(ready) => ready.is_supported(),
                // A parse error is a rejection too; count it as `false`.
                Err(_) => false,
            };
            if got != expect {
                failures.push(format!("{name}: expected {expect}, got {got}"));
            }
        }
        assert_eq!(failures, Vec::<String>::new(), "corpus disagreements");
    }

    #[test]
    fn unsupported_schema_version_is_rejected() {
        let mut ready = valid();
        ready.schema_version = HOST_READY_SCHEMA_VERSION + 1;
        assert!(!ready.is_supported());
    }

    #[test]
    fn a_zero_port_is_not_a_usable_handshake() {
        let mut ready = valid();
        ready.port = 0;
        assert!(!ready.is_supported());
    }

    #[test]
    fn token_must_be_lowercase_hex_of_the_promised_length() {
        let mut ready = valid();
        ready.token = "A".repeat(64); // uppercase hex is not what the host sends
        assert!(!ready.has_valid_token());
        ready.token = "a".repeat(63); // truncated
        assert!(!ready.has_valid_token());
        ready.token = "z".repeat(64); // not hex at all
        assert!(!ready.has_valid_token());
        ready.token = "a".repeat(64);
        assert!(ready.has_valid_token());
    }

    #[test]
    fn host_version_must_be_present_and_bounded() {
        let mut ready = valid();
        ready.host_version = String::new();
        assert!(!ready.is_supported());
        ready.host_version = "v".repeat(65);
        assert!(!ready.is_supported());
    }

    /// The platform vocabulary is shared with plugin-manifest, so an
    /// unrecognised value must be refused rather than passed through.
    #[test]
    fn only_the_contract_vocabulary_is_supported() {
        let mut ready = valid();
        ready.host.platform = "win32".into(); // the raw process.platform spelling
        assert!(!ready.is_supported());
        ready.host.platform = "windows".into();
        ready.host.arch = "ia32".into();
        assert!(!ready.is_supported());
        ready.host.arch = "x64".into();
        ready.host.mode = "prod".into();
        assert!(!ready.is_supported());
    }

    /// The schema is read at test time, so a drift between it and this mirror
    /// fails here rather than silently at runtime.
    #[test]
    fn schema_is_the_versioned_canonical_contract() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../contracts/host-ready/v1/host-ready.schema.json"
        ))
        .unwrap();
        assert_eq!(
            schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
        assert_eq!(schema["$id"], HOST_READY_SCHEMA_ID);
        assert_eq!(schema["properties"]["schemaVersion"]["const"], 1);
        // additionalProperties:false is what makes an unexpected field a
        // contract violation rather than something both sides ignore.
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().unwrap();
        let names: Vec<&str> = required.iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "schemaVersion",
                "port",
                "token",
                "hostVersion",
                "runtime",
                "host",
                "paths",
                "capacity"
            ]
        );
        assert_eq!(schema["properties"]["port"]["minimum"], 1);
        assert_eq!(schema["properties"]["port"]["maximum"], 65535);
        // The platform/arch vocabulary must stay in step with plugin-manifest.
        assert_eq!(
            schema["properties"]["host"]["properties"]["platform"]["enum"][0],
            "windows"
        );
        assert_eq!(
            schema["properties"]["host"]["properties"]["arch"]["enum"][0],
            "x64"
        );
        // The extension slot is bounded, not a free-for-all.
        assert_eq!(schema["properties"]["extra"]["maxProperties"], 32);
        assert_eq!(
            schema["properties"]["capacity"]["properties"]["totalMemBytes"]["maximum"],
            MAX_SAFE_INTEGER
        );
    }
}
