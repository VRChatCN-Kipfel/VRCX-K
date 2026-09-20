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

/// The `schemaVersion` this shell implements. A handshake carrying anything else
/// is refused rather than partially trusted.
pub const HOST_READY_SCHEMA_VERSION: u16 = 1;

#[allow(dead_code)]
pub const HOST_READY_SCHEMA_ID: &str =
    "https://vrcx-k.dev/contracts/host-ready/v1/host-ready.schema.json";

/// The host → shell startup handshake.
///
/// Field order and naming mirror the schema; `hostVersion` is present because the
/// shell supervises the host but has no other way to learn which build it is
/// supervising (`getVersion()` needs the ws connection the face opens later).
///
/// `deny_unknown_fields` is what makes the schema's `additionalProperties:false`
/// true on this side. Without it serde silently ignores an unexpected key, so a
/// host and shell that disagreed about the handshake would both look fine — the
/// exact class of quiet divergence this contract exists to prevent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostReady {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u16,
    pub port: u16,
    pub token: String,
    #[serde(rename = "hostVersion")]
    pub host_version: String,
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
        }
    }

    #[test]
    fn camel_case_on_the_wire_and_snake_case_in_rust() {
        let value = serde_json::to_value(valid()).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["hostVersion"], "0.0.1");
        assert_eq!(value["port"], 43120);
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

    /// The literal frame the TypeScript host emits (captured from a real run),
    /// parsed by this mirror. This is the cross-LANGUAGE check: the tests above
    /// build values in Rust, so they cannot catch the two sides disagreeing
    /// about the wire spelling. If the host renames or moves a field, this is
    /// the test that fails.
    #[test]
    fn the_real_host_frame_parses_into_this_mirror() {
        let wire = r#"{"schemaVersion":1,"port":22394,"token":"5e9643f54bd0fd96f2f2edb9ddc7e66c3ca898393822d644f1af32c317902b94","hostVersion":"0.0.1"}"#;
        let ready: HostReady =
            serde_json::from_str(wire).expect("the host's real frame must parse");
        assert_eq!(ready.schema_version, HOST_READY_SCHEMA_VERSION);
        assert_eq!(ready.port, 22394);
        assert_eq!(ready.host_version, "0.0.1");
        assert!(ready.has_valid_token());
        assert!(ready.is_supported());
    }

    /// An unknown field is a contract violation, not something to ignore: the
    /// host and shell disagreeing about the handshake is the exact failure this
    /// contract exists to name. (`additionalProperties:false` in the schema.)
    #[test]
    fn an_unknown_field_is_rejected_rather_than_ignored() {
        let wire = r#"{"schemaVersion":1,"port":22394,"token":"5e9643f54bd0fd96f2f2edb9ddc7e66c3ca898393822d644f1af32c317902b94","hostVersion":"0.0.1","extra":true}"#;
        assert!(serde_json::from_str::<HostReady>(wire).is_err());
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
        assert_eq!(names, vec!["schemaVersion", "port", "token", "hostVersion"]);
        assert_eq!(schema["properties"]["port"]["minimum"], 1);
        assert_eq!(schema["properties"]["port"]["maximum"], 65535);
    }
}
