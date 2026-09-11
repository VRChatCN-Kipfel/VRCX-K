// Shared dialog option parsing (pure, unit-tested).
//
// The `shell.dialog.*` capability handlers and the dev capability-smoke entry
// point (issue #6) turn the SAME wire strings into plugin enums. That mapping
// is a plain table with no compiler check behind it, so a second copy would
// drift silently — there is exactly one implementation, here.
//
// Everything in this module is pure: no `AppHandle`, no plugin state.

use serde_json::{json, Value};
use tauri_plugin_dialog::{FilePath, MessageDialogButtons, MessageDialogKind};

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

/// Wire value for one picked [`FilePath`].
///
/// A picker result is either a filesystem path or an opaque **URI**, and the
/// two must not be conflated. [`FilePath::into_path`] converts only `file://`
/// URLs: Android's Storage Access Framework hands back `content://`, for which
/// it fails *by design*. The previous implementation turned that failure into
/// `""`, which is the same value a cancelled dialog produces — so on Android a
/// successful pick was indistinguishable from "the user chose nothing", and the
/// callee could not tell a broken bridge from an empty response.
///
/// So: prefer the filesystem reading when one exists (this also keeps `file://`
/// normalised to a real path, which desktop callers rely on), otherwise hand
/// back the URI itself. Interpreting a URI is the caller's job — it may need to
/// read through it rather than open a path, which is exactly the difference the
/// old code erased.
pub fn file_path_to_json(path: FilePath) -> Value {
    match path.clone().into_path() {
        Ok(path) => json!(path.to_string_lossy().to_string()),
        Err(_) => json!(path.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

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

    #[test]
    fn a_content_uri_survives_instead_of_collapsing_to_empty() {
        // The Android picker case. `into_path()` cannot convert a `content://`
        // URI, and the old code turned that failure into `""` — the same value
        // a cancelled dialog yields. Regression guard for exactly that.
        let uri = "content://media/external/images/media/42";
        let picked: FilePath = uri.parse().expect("FilePath::from_str is infallible");
        let wire = file_path_to_json(picked);
        assert_ne!(wire, json!(""), "a picked URI must never look cancelled");
        assert_eq!(wire, json!(uri));
    }

    #[test]
    fn a_filesystem_path_stays_a_path() {
        let picked = FilePath::Path(PathBuf::from(r"C:\Users\me\pic.png"));
        assert_eq!(file_path_to_json(picked), json!(r"C:\Users\me\pic.png"));
    }

    #[test]
    fn a_file_url_never_collapses_to_empty() {
        // Whether a `file://` URL converts is genuinely platform-dependent:
        // `to_file_path()` rejects a URL with no drive letter on Windows, while
        // on unix the drive-less form is the normal one. Either outcome is
        // legitimate, so this pins the invariant that actually matters — the
        // wire value is never `""`, the value a cancelled dialog produces.
        for input in ["file:///tmp/probe.png", "file:///C:/tmp/probe.png"] {
            let picked: FilePath = input.parse().expect("FilePath::from_str is infallible");
            let wire = file_path_to_json(picked);
            assert_ne!(wire, json!(""), "{input} must not collapse to empty");
            let wire = wire.as_str().expect("a string on the wire");
            assert!(!wire.is_empty());
            // Never mangled: it is either the converted path or the URL itself.
            assert!(
                !wire.starts_with("file://") || wire == input,
                "{input} produced something that is neither a path nor the input: {wire}"
            );
        }
    }
}
