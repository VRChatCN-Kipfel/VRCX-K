// Shared dialog option parsing (pure, unit-tested).
//
// The `shell.dialog.*` capability handlers and the dev capability-smoke entry
// point (issue #6) turn the SAME wire strings into plugin enums. That mapping
// is a plain table with no compiler check behind it, so a second copy would
// drift silently — there is exactly one implementation, here.
//
// Everything in this module is pure: no `AppHandle`, no plugin state.

use serde_json::Value;
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

/// Wire `kind` → dialog kind. Missing or unknown falls back to `Info`.
///
/// A bad `kind` is not an error: the capability call still opens a dialog
/// (as an information box) instead of failing to show anything at all.
pub fn message_kind(value: Option<&str>) -> MessageDialogKind {
    match value {
        Some("warning") => MessageDialogKind::Warning,
        Some("error") => MessageDialogKind::Error,
        _ => MessageDialogKind::Info,
    }
}

/// Wire `buttons` → button set. Missing or unknown falls back to `Ok`.
pub fn message_buttons(value: Option<&str>) -> MessageDialogButtons {
    match value {
        Some("okCancel") => MessageDialogButtons::OkCancel,
        Some("yesNo") => MessageDialogButtons::YesNo,
        Some("yesNoCancel") => MessageDialogButtons::YesNoCancel,
        _ => MessageDialogButtons::Ok,
    }
}

/// Which picker a `{ save, directory, multiple }` request selects.
///
/// The precedence is the whole contract (`save` wins over every combination),
/// so it lives in one tested function instead of two hand-written if-chains.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PickMode {
    /// Save one file target.
    Save,
    /// Pick several directories.
    Folders,
    /// Pick one directory.
    Folder,
    /// Pick several files.
    Files,
    /// Pick one file.
    File,
}

/// Decide the picker from the request flags.
pub fn pick_mode(save: bool, directory: bool, multiple: bool) -> PickMode {
    if save {
        PickMode::Save
    } else if directory && multiple {
        PickMode::Folders
    } else if directory {
        PickMode::Folder
    } else if multiple {
        PickMode::Files
    } else {
        PickMode::File
    }
}

/// Optional string field of a JSON options object.
pub fn opt_str<'a>(opts: &'a Value, key: &str) -> Option<&'a str> {
    opts.get(key).and_then(Value::as_str)
}

/// Optional bool field of a JSON options object.
pub fn opt_bool(opts: &Value, key: &str) -> bool {
    opts.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `MessageDialogButtons` deliberately does not implement `PartialEq`
    /// (it carries `String` variants), so compare its serialized form: that is
    /// also the wire spelling, which makes a failure message readable.
    fn buttons_wire(buttons: MessageDialogButtons) -> Value {
        serde_json::to_value(buttons).expect("buttons serialize")
    }

    #[test]
    fn message_kind_maps_documented_values_and_falls_back_to_info() {
        assert_eq!(message_kind(Some("warning")), MessageDialogKind::Warning);
        assert_eq!(message_kind(Some("error")), MessageDialogKind::Error);
        assert_eq!(message_kind(Some("info")), MessageDialogKind::Info);
        // Unknown spelling is not a failure: the dialog still opens.
        assert_eq!(message_kind(Some("fatal")), MessageDialogKind::Info);
        assert_eq!(message_kind(Some("Warning")), MessageDialogKind::Info);
        assert_eq!(message_kind(None), MessageDialogKind::Info);
    }

    #[test]
    fn message_buttons_maps_documented_values_and_falls_back_to_ok() {
        assert_eq!(buttons_wire(message_buttons(Some("ok"))), json!("Ok"));
        assert_eq!(
            buttons_wire(message_buttons(Some("okCancel"))),
            json!("OkCancel")
        );
        assert_eq!(buttons_wire(message_buttons(Some("yesNo"))), json!("YesNo"));
        assert_eq!(
            buttons_wire(message_buttons(Some("yesNoCancel"))),
            json!("YesNoCancel")
        );
        // The wire spelling is case-sensitive by contract.
        assert_eq!(buttons_wire(message_buttons(Some("okcancel"))), json!("Ok"));
        assert_eq!(buttons_wire(message_buttons(None)), json!("Ok"));
    }

    #[test]
    fn pick_mode_precedence_is_save_then_directory_then_multiple() {
        // `save` wins over everything: a save dialog picks one file target.
        assert_eq!(pick_mode(true, false, false), PickMode::Save);
        assert_eq!(pick_mode(true, true, true), PickMode::Save);
        // Directory combinations.
        assert_eq!(pick_mode(false, true, true), PickMode::Folders);
        assert_eq!(pick_mode(false, true, false), PickMode::Folder);
        // File combinations.
        assert_eq!(pick_mode(false, false, true), PickMode::Files);
        assert_eq!(pick_mode(false, false, false), PickMode::File);
    }

    #[test]
    fn opt_helpers_only_accept_the_declared_json_type() {
        let opts = json!({ "title": "t", "count": 3, "flag": true, "off": false });
        assert_eq!(opt_str(&opts, "title"), Some("t"));
        assert_eq!(opt_str(&opts, "count"), None);
        assert_eq!(opt_str(&opts, "missing"), None);
        assert!(opt_bool(&opts, "flag"));
        assert!(!opt_bool(&opts, "off"));
        // A non-bool never silently becomes true.
        assert!(!opt_bool(&opts, "count"));
        assert!(!opt_bool(&opts, "missing"));
    }
}
