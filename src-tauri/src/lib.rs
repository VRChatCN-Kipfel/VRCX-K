mod host;
mod kkrpc_stdio;
mod notify;
mod process_tree;
mod tray;

use host::{supervise_loop, HostReady, HostState};
use tauri::{Emitter, Manager, RunEvent};

#[tauri::command]
fn get_host_ready(state: tauri::State<HostState>) -> Option<HostReady> {
    state.snapshot()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(HostState::default())
        .invoke_handler(tauri::generate_handler![get_host_ready])
        .setup(|app| {
            tray::setup(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<HostState>();
                supervise_loop(state.inner(), |ready| {
                    if let Err(err) = handle.emit("host-ready", &ready) {
                        eprintln!("[shell] emit host-ready: {err}");
                    }
                });
            });
            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                app.state::<HostState>().request_stop();
            }
        });
}
