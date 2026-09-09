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

    #[test]
    fn rejects_unknown_fields_and_snake_case() {
        let valid = json!({
            "schemaVersion": 1,
            "generation": 0,
            "revision": 1,
            "groups": []
        });
        validate_wire_shape(&valid).unwrap();

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
}
