mod app_lifecycle;
mod host;
mod host_lifecycle;
mod kkrpc_stdio;
mod notify;
mod process_tree;
mod shell_sys;
mod tray;

use app_lifecycle::{
    AppCommand, AppCommandRequest, AppCommandResult, AppLifecycle, AppLifecycleFacade,
};
use host::{supervise_loop, HostReady, HostState};
use host_lifecycle::{HostCommand, HostCommandResult, HostSnapshot};
use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};

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
fn dispatch_app_command(
    app: tauri::AppHandle,
    state: tauri::State<HostState>,
    lifecycle: tauri::State<AppLifecycle>,
    request: AppCommandRequest,
) -> AppCommandResult {
    let command = request.command;
    let result = lifecycle.dispatch(request);
    if !matches!(result, AppCommandResult::Accepted { .. }) {
        return result;
    }

    // The Rust shell owns process lifecycle. Latch AppExit before returning so
    // the supervisor cannot relaunch and host/plugin code cannot race this app
    // command. Graceful work runs off the Tauri command thread.
    state.latch_app_exit();
    match command {
        AppCommand::RestartGraceful => {
            std::thread::spawn(move || {
                let state = app.state::<HostState>();
                state.request_app_exit_graceful();
                app.request_restart();
            });
        }
        AppCommand::QuitGraceful => {
            std::thread::spawn(move || {
                let state = app.state::<HostState>();
                state.request_app_exit_graceful();
                app.exit(0);
            });
        }
        AppCommand::QuitForce => {
            // Force quit is allowed to escalate an in-flight graceful worker;
            // taking and killing the tree makes that worker observe no child.
            state.force_app_exit();
            app.exit(0);
        }
    }
    result
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
            dispatch_app_command
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
        .run(|app, event| match event {
            RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                // An OS/user exit not initiated by dispatch_app_command enters
                // the same Rust-owned graceful path. Prevent this first exit;
                // the worker calls app.exit(0) only after stop/force cleanup.
                let request = AppCommandRequest {
                    schema_version: app_lifecycle::APP_LIFECYCLE_SCHEMA_VERSION,
                    command: AppCommand::QuitGraceful,
                };
                let lifecycle = app.state::<AppLifecycle>();
                if matches!(
                    lifecycle.dispatch(request),
                    AppCommandResult::Accepted { .. }
                ) {
                    api.prevent_exit();
                    app.state::<HostState>().latch_app_exit();
                    let exit_app = app.clone();
                    std::thread::spawn(move || {
                        let state = exit_app.state::<HostState>();
                        state.request_app_exit_graceful();
                        exit_app.exit(0);
                    });
                }
            }
            RunEvent::Exit => {
                // Final non-blocking safety net only. Explicit/OS graceful
                // paths already reaped the child; force quit already took it.
                app.state::<HostState>().latch_app_exit();
            }
            _ => {}
        });
}
