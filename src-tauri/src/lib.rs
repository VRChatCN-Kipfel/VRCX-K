mod host;
mod host_lifecycle;
mod kkrpc_stdio;
mod notify;
mod process_tree;
mod shell_sys;
mod tray;

use host::{supervise_loop, HostReady, HostState};
use host_lifecycle::{HostCommand, HostCommandResult, HostSnapshot};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, RunEvent};

#[derive(Default)]
struct AppLifecycle {
    restart_requested: AtomicBool,
}

impl AppLifecycle {
    fn begin_restart(&self) -> Result<(), &'static str> {
        if self.restart_requested.swap(true, Ordering::AcqRel) {
            Err("app restart already in progress")
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct HostLifecycleStateResponse {
    snapshot: HostSnapshot,
}

#[tauri::command]
fn get_host_ready(state: tauri::State<HostState>) -> Option<HostReady> {
    state.snapshot()
}

#[tauri::command]
fn get_host_lifecycle(state: tauri::State<HostState>) -> HostLifecycleStateResponse {
    HostLifecycleStateResponse {
        snapshot: state.lifecycle_snapshot(),
    }
}

#[tauri::command]
fn dispatch_host_command(
    state: tauri::State<HostState>,
    command: HostCommand,
) -> HostCommandResult {
    state.dispatch(command)
}

#[tauri::command]
fn restart_app_graceful(
    app: tauri::AppHandle,
    state: tauri::State<HostState>,
    lifecycle: tauri::State<AppLifecycle>,
) -> Result<(), String> {
    // Latch before returning so duplicate commands and the supervisor both see
    // the restart intent immediately. Slow graceful cleanup never blocks the
    // Tauri command thread; request_stop includes the shared deadline/force
    // fallback before request_restart is invoked.
    lifecycle.begin_restart().map_err(str::to_owned)?;
    state.latch_stop();
    std::thread::spawn(move || {
        let state = app.state::<HostState>();
        state.request_stop();
        app.request_restart();
    });
    Ok(())
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
        .manage(AppLifecycle::default())
        .invoke_handler(tauri::generate_handler![
            get_host_ready,
            get_host_lifecycle,
            dispatch_host_command,
            restart_app_graceful
        ])
        .setup(|app| {
            tray::setup(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<HostState>();
                supervise_loop(state.inner(), Some(&handle), |ready| {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_restart_latch_accepts_once_and_rejects_duplicates() {
        let lifecycle = AppLifecycle::default();
        assert_eq!(lifecycle.begin_restart(), Ok(()));
        assert_eq!(
            lifecycle.begin_restart(),
            Err("app restart already in progress")
        );
    }
}
