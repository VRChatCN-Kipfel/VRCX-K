// Shell notification service — the "hands" notification surface.
//
// Layering (aligned 2026-09):
//   L0  in-app toast   -> React (sonner) — NOT here (WebView-internal)
//   L1  native notify  -> THIS module:
//         * simple cross-platform notify  -> tauri-plugin-notification
//           (win/mac/linux + android/ios one API; installed-app AUMID correct)
//         * Windows-deep toast (buttons/hero/progress) -> tauri-winrt-notification
//           (provisioned dependency; actually used from F3 when real depth lands)
//
// IMPORTANT — the two are STACKED, not alternatives (verified 2026-09-11):
//   tauri-plugin-notification -> notify-rust -> tauri-winrt-notification
//   i.e. the winrt crate is the official plugin's WINDOWS BACKEND. The plain
//   `notify-rust` crate is what the plugin calls on desktop, and notify-rust
//   itself delegates to tauri-winrt-notification on Windows. Direct use below
//   is therefore a DESCENT INTO the layer the plugin already sits on, for the
//   depth the plugin drops: `desktop.rs::show()` forwards only
//   title/body/icon/sound and discards the NotificationHandle inside a spawned
//   task, so buttons/hero/progress/click-callbacks are unreachable through it.
//
// Shell stays a thin proxy: it does NOT parse plugin/business protocols. Host
// (brain) requests a notify via kkrpc/stdio; UI (face) may via Tauri IPC.

use tauri::{AppHandle, Emitter};

/// Send a simple cross-platform notification through the official plugin.
/// Safe to call from anywhere we hold an AppHandle.
#[allow(dead_code)]
pub fn notify_simple(
    app: &AppHandle,
    title: &str,
    body: &str,
) -> Result<(), tauri_plugin_notification::Error> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title.to_string())
        .body(body.to_string())
        .show()
}

/// Windows-deep toast (buttons/hero/etc.). Stub until F3 wires real depth.
/// Kept cfg(windows) so non-Windows builds stay clean; the actual WinRT calls
/// land in F3 (buttons/progress for invites etc.).
#[cfg(windows)]
#[allow(dead_code)] // Intentional placeholder: F3 wires the real WinRT path.
pub fn notify_windows_deep(_app: &AppHandle, _title: &str, _body: &str) -> tauri::Result<()> {
    // TODO(F3): tauri-winrt-notification Toast::new(app_id) with AUMID/icon/buttons.
    // For M1 the simple path (notify_simple) covers the smoke/acceptance; depth
    // is deliberately deferred until a real button/progress use-case exists.
    Ok(())
}

/// Emit a Tauri event to the frontend (e.g. "notify" so the face can show an
/// in-app toast via sonner as well, when the host wants both channels).
#[allow(dead_code)]
pub fn emit_to_frontend(app: &AppHandle, title: &str, body: &str) -> tauri::Result<()> {
    app.emit(
        "notify",
        serde_json::json!({ "title": title, "body": body }),
    )
}
