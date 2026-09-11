// M1-4: shell system capability surface (hands -> host).
//
// The Rust shell registers a forward-looking set of `shell.*` RPC methods on
// the kkrpc/stdio Peer so the host (brain) can ask the shell (hands) for
// system abilities: notifications, dialogs, opener, global shortcuts, window
// control, app metadata and path resolution.
//
// Design notes:
//   - Method names are dot-namespaced (e.g. `shell.notify`); the host side
//     calls them through the kkrpc API proxy (`api.shell.notify(...)`).
//   - Handlers run on the Peer reader thread; anything blocking (dialogs)
//     uses the plugin's `blocking_*` API on purpose (M1 smoke scope).
//   - Capability set is intentionally generous now (前瞻性): more surface is
//     cheaper to ship than to retrofit. Unused handlers are still exercised
//     by the host-side type definitions, and each is a thin wrapper.

use crate::dialog_opts;
use crate::kkrpc_peer::Peer;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

fn str_arg(args: &[Value], i: usize) -> String {
    args.get(i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Register every `shell.*` capability handler on the peer.
///
/// `app` is cloned into each closure so the reader thread can reach Tauri
/// state without borrowing the builder's handle.
pub fn register_shell_handlers(peer: &Arc<Peer>, app: AppHandle) {
    // --- notifications -----------------------------------------------------
    // shell.notify(title, body) -> bool
    peer.on(
        "shell.notify",
        handler(app.clone(), |app, args| {
            let title = str_arg(args, 0);
            let body = str_arg(args, 1);
            let result = app.notification().builder().title(title).body(body).show();
            json!(result.is_ok())
        }),
    );

    // --- dialogs -----------------------------------------------------------
    // shell.dialog.message(text, opts) -> bool (true = OK/Yes pressed)
    // opts: { title?, kind?: "info"|"warning"|"error", buttons?: "ok"|"okCancel"|"yesNo"|"yesNoCancel" }
    peer.on(
        "shell.dialog.message",
        handler(app.clone(), |app, args| {
            let text = str_arg(args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let title = dialog_opts::opt_str(&opts, "title").unwrap_or("");
            let kind = dialog_opts::message_kind(dialog_opts::opt_str(&opts, "kind"));
            let buttons = dialog_opts::message_buttons(dialog_opts::opt_str(&opts, "buttons"));
            let mut builder = app.dialog().message(text).kind(kind).buttons(buttons);
            if !title.is_empty() {
                builder = builder.title(title);
            }
            json!(builder.blocking_show())
        }),
    );

    // shell.dialog.ask(text, opts) -> "yes"|"no"|"cancel"|"ok"
    // Same options as message; returns the raw button result.
    peer.on(
        "shell.dialog.ask",
        handler(app.clone(), |app, args| {
            let text = str_arg(args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let title = dialog_opts::opt_str(&opts, "title").unwrap_or("");
            let buttons = dialog_opts::message_buttons(dialog_opts::opt_str(&opts, "buttons"));
            let mut builder = app.dialog().message(text).buttons(buttons);
            if !title.is_empty() {
                builder = builder.title(title);
            }
            let result = builder.blocking_show_with_result();
            let label = match result {
                tauri_plugin_dialog::MessageDialogResult::Yes => "yes",
                tauri_plugin_dialog::MessageDialogResult::No => "no",
                tauri_plugin_dialog::MessageDialogResult::Ok => "ok",
                tauri_plugin_dialog::MessageDialogResult::Cancel => "cancel",
                _ => "unknown",
            };
            json!(label)
        }),
    );

    // shell.dialog.pickFile(opts) -> string | string[] | null
    // opts: { multiple?: bool, directory?: bool, save?: bool }
    peer.on(
        "shell.dialog.pickFile",
        handler(app.clone(), |app, args| {
            let opts = args.first().cloned().unwrap_or_else(|| json!({}));
            let save = dialog_opts::opt_bool(&opts, "save");
            let directory = dialog_opts::opt_bool(&opts, "directory");
            let multiple = dialog_opts::opt_bool(&opts, "multiple");
            let builder = app.dialog().file();
            // The flag precedence lives in `dialog_opts::pick_mode` (one tested
            // implementation shared with the smoke entry point).
            let picked: Option<Value> = match dialog_opts::pick_mode(save, directory, multiple) {
                dialog_opts::PickMode::Save => builder
                    .blocking_save_file()
                    .map(dialog_opts::file_path_to_json),
                // Folder picking is desktop-only: the mobile dialog plugin
                // exposes file picking but has no folder API. A folder request
                // there reports "nothing picked" rather than silently
                // degrading into a file picker (which would look like the user
                // cancelled a dialog they were never shown).
                #[cfg(desktop)]
                dialog_opts::PickMode::Folders => builder.blocking_pick_folders().map(|paths| {
                    Value::Array(
                        paths
                            .into_iter()
                            .map(dialog_opts::file_path_to_json)
                            .collect(),
                    )
                }),
                #[cfg(desktop)]
                dialog_opts::PickMode::Folder => builder
                    .blocking_pick_folder()
                    .map(dialog_opts::file_path_to_json),
                #[cfg(not(desktop))]
                dialog_opts::PickMode::Folders | dialog_opts::PickMode::Folder => None,
                dialog_opts::PickMode::Files => builder.blocking_pick_files().map(|paths| {
                    Value::Array(
                        paths
                            .into_iter()
                            .map(dialog_opts::file_path_to_json)
                            .collect(),
                    )
                }),
                dialog_opts::PickMode::File => builder
                    .blocking_pick_file()
                    .map(dialog_opts::file_path_to_json),
            };
            match picked {
                Some(v) => v,
                None => Value::Null,
            }
        }),
    );

    // --- opener ------------------------------------------------------------
    // shell.openUrl(url) -> bool
    peer.on(
        "shell.openUrl",
        handler(app.clone(), |app, args| {
            let url = str_arg(args, 0);
            json!(app.opener().open_url(url, None::<&str>).is_ok())
        }),
    );

    // shell.openPath(path) -> bool
    peer.on(
        "shell.openPath",
        handler(app.clone(), |app, args| {
            let path = str_arg(args, 0);
            json!(app.opener().open_path(path, None::<&str>).is_ok())
        }),
    );

    // shell.reveal(path) -> bool  (show file in its directory)
    peer.on(
        "shell.reveal",
        handler(app.clone(), |app, args| {
            let path = str_arg(args, 0);
            json!(app.opener().reveal_item_in_dir(path).is_ok())
        }),
    );

    // --- global shortcuts --------------------------------------------------
    // Desktop-only: there is no OS-wide hotkey facility on mobile, and the
    // plugin does not expose its types there. The routes are not registered at
    // all, so a call gets the peer's standard "no such method" reply instead of
    // a `{ok:false}` that implies the chord was parsed and merely refused.
    #[cfg(desktop)]
    {
        // shell.shortcut.register(accelerator) -> ShortcutRegistration
        // Accelerator strings follow the plugin syntax, e.g. "CommandOrControl+Shift+N".
        //
        // The reply carries the CANONICAL spelling (`shift+control+KeyN`) so the
        // caller can match the `shortcut.pressed` events it will receive without
        // re-implementing accelerator parsing: chord identity has exactly one
        // implementation (the plugin's parser, via crate::shortcut).
        peer.on(
            "shell.shortcut.register",
            handler(app.clone(), |app, args| {
                let accel = str_arg(args, 0);
                let registration = match crate::shortcut::parse_accelerator(&accel) {
                    Ok(shortcut) => crate::shortcut::register_with_os(app, shortcut),
                    Err(err) => crate::shortcut::ShortcutRegistration::rejected(err),
                };
                serde_json::to_value(registration)
                    .unwrap_or_else(|err| json!({ "ok": false, "error": err.to_string() }))
            }),
        );

        // shell.shortcut.unregister(accelerator) -> ShortcutRegistration
        peer.on(
            "shell.shortcut.unregister",
            handler(app.clone(), |app, args| {
                let accel = str_arg(args, 0);
                let registration = match crate::shortcut::parse_accelerator(&accel) {
                    Ok(shortcut) => crate::shortcut::unregister_with_os(app, shortcut),
                    Err(err) => crate::shortcut::ShortcutRegistration::rejected(err),
                };
                serde_json::to_value(registration)
                    .unwrap_or_else(|err| json!({ "ok": false, "error": err.to_string() }))
            }),
        );

        // shell.shortcut.isRegistered(accelerator) -> bool
        peer.on(
            "shell.shortcut.isRegistered",
            handler(app.clone(), |app, args| {
                let accel = str_arg(args, 0);
                match accel.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                    Ok(shortcut) => json!(app.global_shortcut().is_registered(shortcut)),
                    Err(_) => json!(false),
                }
            }),
        );
    }

    // --- window control (main webview window) ------------------------------
    // shell.window.show() / hide() / minimize() / maximize() / unmaximize()
    // / focus() / close() -> bool
    //
    // `minimize`/`maximize`/`unmaximize` are desktop-only: the mobile webview
    // window API has no such operations. They are left out of the route list
    // there rather than matched to a no-op, so the peer reports an unknown
    // method instead of returning `true` for a window nothing happened to.
    #[cfg(desktop)]
    const WINDOW_ACTIONS: &[&str] = &[
        "show",
        "hide",
        "minimize",
        "maximize",
        "unmaximize",
        "focus",
        "close",
    ];
    #[cfg(not(desktop))]
    const WINDOW_ACTIONS: &[&str] = &["show", "hide", "focus", "close"];

    for action in WINDOW_ACTIONS {
        let method = format!("shell.window.{action}");
        let app = app.clone();
        peer.on(
            &method,
            Arc::new(move |_args: Vec<Value>| {
                let Some(win) = app.get_webview_window("main") else {
                    return json!(false);
                };
                let result = match *action {
                    "show" => win.show(),
                    "hide" => win.hide(),
                    #[cfg(desktop)]
                    "minimize" => win.minimize(),
                    #[cfg(desktop)]
                    "maximize" => win.maximize(),
                    #[cfg(desktop)]
                    "unmaximize" => win.unmaximize(),
                    "focus" => win.set_focus(),
                    "close" => win.close(),
                    _ => Ok(()),
                };
                json!(result.is_ok())
            }),
        );
    }

    // --- app metadata ------------------------------------------------------
    // shell.app.info() -> { name, version, identifier }
    peer.on(
        "shell.app.info",
        handler(app.clone(), |app, _args| {
            let config = app.config();
            json!({
                "name": config.product_name.clone(),
                "version": config.version.clone(),
                "identifier": config.identifier.clone(),
            })
        }),
    );

    // shell.app.exit(code?) -> never returns (app quits)
    peer.on(
        "shell.app.exit",
        handler(app.clone(), |app, args| {
            let code = args.first().and_then(Value::as_u64).unwrap_or(0) as i32;
            app.exit(code);
            json!(true)
        }),
    );

    // --- paths -------------------------------------------------------------
    // shell.path.dir() -> { config, data, cache, temp, home }
    peer.on(
        "shell.path.dir",
        handler(app.clone(), |app, _args| {
            let path = app.path();
            let get = |f: &dyn Fn(
                &tauri::path::PathResolver<tauri::Wry>,
            ) -> Result<std::path::PathBuf, tauri::Error>| {
                f(path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            };
            json!({
                "config": get(&|p| p.app_config_dir()),
                "data": get(&|p| p.app_data_dir()),
                "cache": get(&|p| p.app_cache_dir()),
                "temp": get(&|p| p.temp_dir()),
                "home": get(&|p| p.home_dir()),
            })
        }),
    );

    // shell.path.resolve(kind) -> string
    // kind: "config"|"data"|"cache"|"temp"|"home"
    peer.on(
        "shell.path.resolve",
        handler(app.clone(), |app, args| {
            let kind = str_arg(args, 0);
            let path = app.path();
            let resolved = match kind.as_str() {
                "config" => path.app_config_dir(),
                "data" => path.app_data_dir(),
                "cache" => path.app_cache_dir(),
                "temp" => path.temp_dir(),
                "home" => path.home_dir(),
                _ => return json!(""),
            };
            json!(resolved
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default())
        }),
    );

    // shell.devWatchEvent(event) -> bool
    // #11 wiring: the host relays dev-watch state (reload results, config
    // refresh, restart-required) to the face by calling this method; the shell
    // re-emits it as a Tauri `dev-watch` event for the webview. The payload is
    // a #11-owned plain JSON object (never a #7 lifecycle DTO). Fire-and-forget
    // on the host side, so an absent handler (tests / no UI) is harmless.
    peer.on(
        "shell.devWatchEvent",
        handler(app.clone(), |app, args| {
            let payload = args.first().cloned().unwrap_or_else(|| json!({}));
            match app.emit("dev-watch", payload) {
                Ok(()) => json!(true),
                Err(err) => {
                    eprintln!("[shell] emit dev-watch: {err}");
                    json!(false)
                }
            }
        }),
    );

    // shell.tray.setSnapshot(snapshot) -> { ok, revision, error? }
    // The only ingress for host/plugin-owned declarative tray groups. The
    // snapshot is validated against the JSON Schema and the domain model before
    // it is cached; core groups are rejected (Rust-owned). The reply is
    // synchronous so the host knows whether its menu was accepted.
    //
    // Desktop-only: a declarative tray snapshot has no meaning where there is
    // no tray, so the route is absent rather than accepting and discarding it.
    #[cfg(desktop)]
    peer.on(
        "shell.tray.setSnapshot",
        handler(app.clone(), |app, args| {
            let payload = args.first().cloned().unwrap_or_else(|| json!({}));
            let verdict = crate::tray::apply_host_snapshot(app, payload);
            serde_json::to_value(verdict).unwrap_or_else(
                |err| json!({ "ok": false, "revision": 0, "error": err.to_string() }),
            )
        }),
    );
}

/// Helper to build a handler closure that clones the app handle.
fn handler<F>(app: AppHandle, f: F) -> crate::kkrpc_peer::Handler
where
    F: Fn(&AppHandle, &[Value]) -> Value + Send + Sync + 'static,
{
    Arc::new(move |args: Vec<Value>| f(&app, &args))
}
