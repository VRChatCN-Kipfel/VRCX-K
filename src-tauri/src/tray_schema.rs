//! Rust types generated from the canonical tray-menu JSON Schema.
//!
//! Do not hand-edit the declarations in this module. The schema is the source of
//! truth shared with the host TypeScript side.

use serde_json::Value;

typify::import_types!(schema = "../contracts/tray-menu.schema.json");

/// Validate the wire shape using the schema-generated serde type.
///
/// Domain constraints (global IDs, ordering, separators, and radio exclusivity)
/// remain in `tray_model::TrayMenuSnapshot::normalize`.
pub(crate) fn validate_wire_shape(value: &Value) -> Result<(), String> {
    serde_json::from_value::<TrayMenuSnapshot>(value.clone())
        .map_err(|error| format!("invalid tray menu schema: {error}"))?;
    for field in ["generation", "revision"] {
        let number = value
            .get(field)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("{field} must be a non-negative safe integer"))?;
        if number > 9_007_199_254_740_991 {
            return Err(format!("{field} exceeds JavaScript safe integer range"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_wire_shape;
    use serde_json::json;

    fn valid_snapshot() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "generation": 0,
            "revision": 1,
            "groups": []
        })
    }

    #[test]
    fn rejects_unknown_fields_and_snake_case() {
        validate_wire_shape(&valid_snapshot()).unwrap();

        let unknown = json!({
            "schemaVersion": 1,
            "generation": 0,
            "revision": 1,
            "groups": [],
            "unexpected": true
        });
        assert!(validate_wire_shape(&unknown).is_err());

        let snake = json!({
            "schema_version": 1,
            "generation": 0,
            "revision": 1,
            "groups": []
        });
        assert!(validate_wire_shape(&snake).is_err());
    }

    #[test]
    fn accepts_a_full_nested_core_and_host_snapshot() {
        let full = json!({
            "schemaVersion": 1,
            "generation": 7,
            "revision": 42,
            "groups": [
                {
                    "id": "core.controls",
                    "order": 1000,
                    "label": null,
                    "visible": true,
                    "source": "core",
                    "items": [
                        {
                            "kind": "action",
                            "id": "core.window.show",
                            "order": 0,
                            "label": "Show",
                            "enabled": true,
                            "visible": true,
                            "action": {
                                "target": "core",
                                "command": "window.show",
                                "args": [],
                                "danger": "safe",
                                "confirm": false
                            }
                        },
                        {
                            "kind": "check",
                            "id": "core.option.check",
                            "order": 1,
                            "label": "Check",
                            "enabled": true,
                            "visible": true,
                            "checked": false,
                            "radioGroup": null,
                            "action": {
                                "target": "core",
                                "command": "window.show",
                                "args": [],
                                "danger": "safe",
                                "confirm": false
                            }
                        },
                        {
                            "kind": "submenu",
                            "id": "core.developer",
                            "order": 2,
                            "label": "Dev",
                            "enabled": true,
                            "visible": true,
                            "items": [
                                {
                                    "kind": "action",
                                    "id": "core.devtools.open",
                                    "order": 0,
                                    "label": "DevTools",
                                    "enabled": true,
                                    "visible": true,
                                    "action": {
                                        "target": "core",
                                        "command": "devtools.open",
                                        "args": [],
                                        "danger": "safe",
                                        "confirm": false
                                    }
                                }
                            ]
                        },
                        { "kind": "separator", "id": "sep1", "order": 3, "visible": true }
                    ]
                },
                {
                    "id": "host.plugins",
                    "order": 2000,
                    "label": "Plugins",
                    "visible": true,
                    "source": "host",
                    "items": [
                        {
                            "kind": "radio",
                            "id": "host.profile.a",
                            "order": 0,
                            "label": "A",
                            "enabled": true,
                            "visible": true,
                            "checked": true,
                            "radioGroup": "profile",
                            "action": {
                                "target": "host",
                                "command": "profile.set",
                                "args": ["a"],
                                "danger": "safe",
                                "confirm": false
                            }
                        }
                    ]
                }
            ]
        });
        validate_wire_shape(&full).unwrap();
    }

    #[test]
    fn rejects_bad_targets_kinds_sources_and_missing_required() {
        // Unknown action target.
        let mut bad_target = valid_snapshot();
        bad_target["groups"] = json!([{
            "id": "core.controls", "order": 0, "label": null, "visible": true,
            "source": "core",
            "items": [{
                "kind": "action", "id": "core.a", "order": 0, "label": "A",
                "enabled": true, "visible": true,
                "action": { "target": "kernel", "command": "a", "args": [],
                            "danger": "safe", "confirm": false }
            }]
        }]);
        assert!(validate_wire_shape(&bad_target).is_err());

        // Unknown item kind.
        let mut bad_kind = valid_snapshot();
        bad_kind["groups"] = json!([{
            "id": "core.controls", "order": 0, "label": null, "visible": true,
            "source": "core",
            "items": [{ "kind": "hyperlink", "id": "core.a", "order": 0 }]
        }]);
        assert!(validate_wire_shape(&bad_kind).is_err());

        // A host group with a host-target action is valid at the wire layer.
        let mut host_ok = valid_snapshot();
        host_ok["groups"] = json!([{
            "id": "host.g", "order": 0, "label": null, "visible": true, "source": "host",
            "items": [{
                "kind": "action", "id": "host.a", "order": 0, "label": "A",
                "enabled": true, "visible": true,
                "action": { "target": "host", "command": "do.work", "args": [],
                            "danger": "safe", "confirm": false }
            }]
        }]);
        validate_wire_shape(&host_ok).unwrap();

        // KNOWN TYPIFY LIMITATION: the untagged `TrayGroup` oneOf does not
        // discriminate host-group item targets, so wire validation ACCEPTS a
        // host group whose action targets core/app. The Rust domain layer
        // (`tray_model::TrayMenuSnapshot::normalize`) rejects such escalation
        // (non-core groups only allow target=host), so the semantic gate lives
        // there. This test pins the wire behavior so a future schema/tooling
        // change that tightens it is noticed.
        for target in ["core", "app"] {
            let mut escalation = valid_snapshot();
            escalation["groups"] = json!([{
                "id": "host.g", "order": 0, "label": null, "visible": true, "source": "host",
                "items": [{
                    "kind": "action", "id": "host.a", "order": 0, "label": "A",
                    "enabled": true, "visible": true,
                    "action": { "target": target, "command": "do.work", "args": [],
                                "danger": "safe", "confirm": false }
                }]
            }]);
            assert!(
                validate_wire_shape(&escalation).is_ok(),
                "wire layer currently accepts host group target={target} (typify oneOf limit)"
            );
        }

        // A core group with a host-target action is rejected at the wire layer
        // (CoreAction restricts target to core/app).
        let mut core_host = valid_snapshot();
        core_host["groups"] = json!([{
            "id": "core.controls", "order": 0, "label": null, "visible": true,
            "source": "core",
            "items": [{
                "kind": "action", "id": "core.a", "order": 0, "label": "A",
                "enabled": true, "visible": true,
                "action": { "target": "host", "command": "do.work", "args": [],
                            "danger": "safe", "confirm": false }
            }]
        }]);
        assert!(validate_wire_shape(&core_host).is_err());

        // Missing required top-level fields.
        for missing in ["schemaVersion", "generation", "groups"] {
            let mut m = valid_snapshot();
            m.as_object_mut().unwrap().remove(missing);
            assert!(
                validate_wire_shape(&m).is_err(),
                "missing {missing} must be rejected"
            );
        }
        // KNOWN TYPIFY LIMITATION: the untagged `TrayGroup` oneOf also does
        // not reject an unknown source value at the wire layer. The domain
        // normalize() layer rejects such groups semantically; this pins the
        // wire behavior for future tooling changes.
        let mut bad_source = valid_snapshot();
        bad_source["groups"] = json!([{
            "id": "g", "order": 0, "label": null, "visible": true, "source": "kernel",
            "items": []
        }]);
        assert!(
            validate_wire_shape(&bad_source).is_ok(),
            "wire layer currently accepts unknown source (typify oneOf limit)"
        );
    }

    #[test]
    fn rejects_unsafe_generation_and_revision_numbers() {
        // Negative.
        let mut negative = valid_snapshot();
        negative["generation"] = json!(-1);
        assert!(validate_wire_shape(&negative).is_err());
        // Fractional.
        let mut fractional = valid_snapshot();
        fractional["revision"] = json!(1.5);
        assert!(validate_wire_shape(&fractional).is_err());
        // Beyond the JS safe-integer bound.
        let mut overflow = valid_snapshot();
        overflow["generation"] = json!(9_007_199_254_740_992u64);
        assert!(validate_wire_shape(&overflow).is_err());
        let mut revision_overflow = valid_snapshot();
        revision_overflow["revision"] = json!(9_007_199_254_740_992u64);
        assert!(validate_wire_shape(&revision_overflow).is_err());
        // The bound itself is accepted.
        let mut bound = valid_snapshot();
        bound["generation"] = json!(9_007_199_254_740_991u64);
        bound["revision"] = json!(9_007_199_254_740_991u64);
        assert!(validate_wire_shape(&bound).is_ok());
        // Missing generation/revision are schema-required and rejected.
        let mut no_gen = valid_snapshot();
        no_gen.as_object_mut().unwrap().remove("generation");
        assert!(validate_wire_shape(&no_gen).is_err());
    }
}
