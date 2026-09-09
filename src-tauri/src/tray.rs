// M1-1: Rust-owned system tray setup, core menu declaration and routing.
//
// The tray is a Rust-owned surface: window/webview/devtools items are routed
// directly, `core.host.*` items are dispatched through #7's HostLifecycle
// facade (synchronous verdict + supervisor execution), and `core.app.*` items
// are dispatched through #7's AppLifecycle facade. The shell never delegates
// process lifecycle to the host or the web view.

use crate::app_lifecycle::{
    AppCommand, AppCommandRequest, AppCommandResult, AppLifecycle, AppLifecycleFacade,
};
use crate::host::HostState;
use crate::host_lifecycle::{HostCommand, HostLifecycleFacade, HostLifecycleState, HostSnapshot};
use crate::tray_model::{
    TrayAction, TrayActionItem, TrayActionTarget, TrayDanger, TrayGroup, TrayItem,
    TrayMenuSnapshot, TraySource,
};
use crate::tray_renderer::TrayRenderer;
use std::sync::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const TRAY_ID: &str = "main-tray";

pub struct TrayState(Mutex<TrayRenderer<tauri::Wry>>);

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| route_core_action(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    let mut renderer = TrayRenderer::new(tray);
    let snapshot = app
        .try_state::<HostState>()
        .map(|state| project_host_items(core_snapshot(), state.lifecycle_snapshot()))
        .unwrap_or_else(core_snapshot);
    renderer.apply(snapshot).map_err(setup_error)?;
    app.manage(TrayState(Mutex::new(renderer)));
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview window not found".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    if window.is_minimized().map_err(|error| error.to_string())? {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    window.set_focus().map_err(|error| error.to_string())
}

/// Dispatch one tray action to its Rust-owned owner.
///
/// Only actions declared in the core snapshot (see `core_snapshot`) can reach
/// this router; anything else was rejected during normalization. Host items
/// (`host.*`) are *core-owned* tray items whose payload is a #7 `HostCommand`
/// — they never travel as `target=host` business RPC. App items
/// (`app.*`) are dispatched through #7's `AppLifecycle` facade.
fn route_core_action(app: &AppHandle, id: &str) {
    let action = app
        .try_state::<TrayState>()
        .and_then(|state| state.0.lock().ok()?.action(id));
    let result = match action
        .as_ref()
        .map(|action| (action.target.clone(), action.command.as_str()))
    {
        Some((TrayActionTarget::Core, "window.show")) => show_main_window(app),
        Some((TrayActionTarget::Core, "window.close")) => app
            .get_webview_window("main")
            .ok_or_else(|| "main webview window not found".to_string())
            .and_then(|window| window.close().map_err(|error| error.to_string())),
        Some((TrayActionTarget::Core, "webview.reload")) => app
            .get_webview_window("main")
            .ok_or_else(|| "main webview window not found".to_string())
            .and_then(|window| window.reload().map_err(|error| error.to_string())),
        #[cfg(debug_assertions)]
        Some((TrayActionTarget::Core, "devtools.open")) => {
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
                Ok(())
            } else {
                Err("main webview window not found".into())
            }
        }
        Some((TrayActionTarget::Core, "host.start")) => dispatch_host(app, HostCommand::Start),
        Some((TrayActionTarget::Core, "host.stop.graceful")) => {
            dispatch_host(app, HostCommand::GracefulStop)
        }
        Some((TrayActionTarget::Core, "host.restart")) => dispatch_host(app, HostCommand::Restart),
        Some((TrayActionTarget::Core, "host.reload")) => dispatch_host(app, HostCommand::Reload),
        Some((TrayActionTarget::App, "app.restart.graceful")) => {
            dispatch_app(app, AppCommand::RestartGraceful)
        }
        Some((TrayActionTarget::App, "app.quit.graceful")) => {
            dispatch_app(app, AppCommand::QuitGraceful)
        }
        Some((TrayActionTarget::App, "app.quit.force")) => dispatch_app(app, AppCommand::QuitForce),
        Some(_) => Err("tray action is not allowlisted".into()),
        None => return,
    };
    if let Err(error) = result {
        eprintln!("[shell] tray action {id}: {error}");
    }
}

/// Send a host lifecycle command through #7's HostLifecycleFacade.
///
/// `HostState` implements the facade: the verdict is the synchronous reducer
/// result (Accepted/Noop/Rejected), and Accepted commands are executed by the
/// supervisor thread off this caller, so this never blocks the tray event
/// loop on host RPC or process teardown.
fn dispatch_host(app: &AppHandle, command: HostCommand) -> Result<(), String> {
    let state = app
        .try_state::<HostState>()
        .ok_or_else(|| "host lifecycle facade not managed".to_string())?;
    match HostLifecycleFacade::dispatch(&*state, command) {
        crate::host_lifecycle::HostCommandResult::Accepted { .. } => Ok(()),
        crate::host_lifecycle::HostCommandResult::Noop { phase } => {
            eprintln!("[shell] host command {command:?} is a no-op in phase {phase:?}");
            Ok(())
        }
        crate::host_lifecycle::HostCommandResult::Rejected { phase, reason } => Err(format!(
            "host command {command:?} rejected in phase {phase:?}: {reason}"
        )),
    }
}

/// Send an application command through #7's AppLifecycle facade.
///
/// The latch is idempotent: a repeat of an already-accepted command returns
/// Noop instead of starting a second worker, and force quit may escalate an
/// in-flight graceful command. Accepted commands are executed by the shared
/// Rust-owned orchestration (`crate::execute_app_command`), which latches
/// AppExit and performs teardown off this caller.
fn dispatch_app(app: &AppHandle, command: AppCommand) -> Result<(), String> {
    let lifecycle = app
        .try_state::<AppLifecycle>()
        .ok_or_else(|| "app lifecycle facade not managed".to_string())?;
    let request = AppCommandRequest {
        schema_version: crate::app_lifecycle::APP_LIFECYCLE_SCHEMA_VERSION,
        command,
    };
    match AppLifecycleFacade::dispatch(&*lifecycle, request) {
        AppCommandResult::Accepted { .. } => {
            crate::execute_app_command(app.clone(), command);
            Ok(())
        }
        AppCommandResult::Noop { .. } => {
            // Idempotent latch: the command is already in flight.
            eprintln!("[shell] app command {command:?} is already in progress");
            Ok(())
        }
        AppCommandResult::Rejected { reason, .. } => {
            Err(format!("app command {command:?} rejected: {reason}"))
        }
    }
}

fn core_snapshot() -> TrayMenuSnapshot {
    let mut items = vec![
        core_action(
            "core.window.show",
            0,
            "Show VRCX-K",
            "window.show",
            TrayActionTarget::Core,
            true,
        ),
        core_action(
            "core.window.close",
            10,
            "Close Window",
            "window.close",
            TrayActionTarget::Core,
            true,
        ),
        core_action(
            "core.webview.reload",
            20,
            "Reload WebView",
            "webview.reload",
            TrayActionTarget::Core,
            true,
        ),
    ];
    #[cfg(debug_assertions)]
    items.push(core_action(
        "core.devtools.open",
        30,
        "Open DevTools",
        "devtools.open",
        TrayActionTarget::Core,
        true,
    ));
    // Rust-owned host lifecycle group (#7 facade). Host process management is
    // a core surface: the shell supervises the host, so these are target=Core
    // tray items carrying a HostCommand payload — never target=host business
    // RPC. Enablement is projected from the HostSnapshot phase at setup (and
    // refreshed when a state feed lands in A3).
    items.extend([
        core_action(
            "core.host.start",
            40,
            "Start Host",
            "host.start",
            TrayActionTarget::Core,
            true,
        ),
        core_action(
            "core.host.stop.graceful",
            50,
            "Stop Host",
            "host.stop.graceful",
            TrayActionTarget::Core,
            true,
        ),
        core_action(
            "core.host.restart",
            60,
            "Restart Host",
            "host.restart",
            TrayActionTarget::Core,
            true,
        ),
        core_action(
            "core.host.reload",
            70,
            "Reload Host",
            "host.reload",
            TrayActionTarget::Core,
            true,
        ),
    ]);
    items.extend([
        core_action(
            "core.app.restart.graceful",
            100,
            "Restart Application",
            "app.restart.graceful",
            TrayActionTarget::App,
            true,
        ),
        core_action(
            "core.app.quit.graceful",
            110,
            "Quit",
            "app.quit.graceful",
            TrayActionTarget::App,
            true,
        ),
        core_action(
            "core.app.quit.force",
            120,
            "Force Quit",
            "app.quit.force",
            TrayActionTarget::App,
            true,
        ),
    ]);
    TrayMenuSnapshot {
        schema_version: 1,
        generation: 0,
        revision: 0,
        groups: vec![TrayGroup {
            id: "core.controls".into(),
            order: i32::MAX,
            label: None,
            visible: true,
            source: TraySource::Core,
            items,
        }],
    }
}

/// Project host-snapshot phase onto the enabled state of `core.host.*` items.
///
/// The authoritative command gate is #7's synchronous reducer
/// (`reduce_command`): an item is enabled exactly when dispatching its
/// command would not be a guaranteed rejection. This mirrors the reducer's
/// acceptance table and is kept as a pure function so it can be unit-tested
/// without a running supervisor.
pub(crate) fn host_command_enabled(phase: HostLifecycleState, command: &str) -> bool {
    use HostLifecycleState::{Backoff, Failed, Ready, Starting, Stopped};
    match command {
        "host.start" => matches!(phase, Stopped | Failed | Backoff),
        "host.stop.graceful" => matches!(phase, Starting | Ready | Backoff),
        "host.restart" => matches!(phase, Stopped | Failed | Backoff | Ready),
        "host.reload" => matches!(phase, Ready),
        _ => false,
    }
}

/// Project a real `HostSnapshot` onto the enabled state of host items.
pub(crate) fn project_host_items(
    mut snapshot: TrayMenuSnapshot,
    host: HostSnapshot,
) -> TrayMenuSnapshot {
    fn set_host_enabled(items: &mut [TrayItem], phase: HostLifecycleState) {
        for item in items {
            match item {
                TrayItem::Action(action) => {
                    if action.id.starts_with("core.host.") {
                        action.enabled = host_command_enabled(phase, &action.action.command);
                    }
                }
                TrayItem::Submenu(submenu) => set_host_enabled(&mut submenu.items, phase),
                _ => {}
            }
        }
    }
    for group in &mut snapshot.groups {
        set_host_enabled(&mut group.items, host.phase);
    }
    snapshot
}

fn core_action(
    id: &str,
    order: i32,
    label: &str,
    command: &str,
    target: TrayActionTarget,
    enabled: bool,
) -> TrayItem {
    TrayItem::Action(TrayActionItem {
        id: id.into(),
        order,
        label: label.into(),
        enabled,
        visible: true,
        action: TrayAction {
            target,
            command: command.into(),
            args: vec![],
            danger: if command.ends_with("force") {
                TrayDanger::Destructive
            } else {
                TrayDanger::Safe
            },
            confirm: command.ends_with("force"),
        },
    })
}

fn setup_error(message: String) -> tauri::Error {
    // `tauri::Error::Setup` wraps a private `SetupError` that is not
    // constructible outside the crate; `Io` is the public equivalent that
    // still surfaces through `tauri::Builder::setup`.
    tauri::Error::Io(std::io::Error::other(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_item<'a>(items: &'a [TrayItem], id: &str) -> Option<&'a TrayActionItem> {
        items.iter().find_map(|item| match item {
            TrayItem::Action(action) if action.id == id => Some(action),
            _ => None,
        })
    }

    #[test]
    fn core_controls_are_rust_owned_and_force_quit_is_last() {
        let snapshot = core_snapshot().normalize().unwrap();
        let group = &snapshot.groups[0];
        assert_eq!(group.source, TraySource::Core);
        assert_eq!(
            match group.items.last().unwrap() {
                TrayItem::Action(item) => item.id.as_str(),
                _ => "",
            },
            "core.app.quit.force"
        );
        // Graceful app items are enabled now that the #7 AppLifecycle facade
        // is wired: the dispatch latch is idempotent and rejects nothing while
        // the app is running.
        for id in ["core.app.restart.graceful", "core.app.quit.graceful"] {
            let item = find_item(&group.items, id).unwrap();
            assert!(
                item.enabled,
                "{id} must be enabled once the facade is wired"
            );
            assert_eq!(item.action.target, TrayActionTarget::App);
        }
        let force = find_item(&group.items, "core.app.quit.force").unwrap();
        assert!(force.enabled);
        assert_eq!(force.action.danger, TrayDanger::Destructive);
    }

    #[test]
    fn core_host_items_are_rust_owned_allowlist_commands() {
        let snapshot = core_snapshot().normalize().unwrap();
        let group = &snapshot.groups[0];
        let commands: Vec<(&str, &str)> = [
            "core.host.start",
            "core.host.stop.graceful",
            "core.host.restart",
            "core.host.reload",
        ]
        .iter()
        .map(|id| {
            let item = find_item(&group.items, id).unwrap();
            (item.id.as_str(), item.action.command.as_str())
        })
        .collect();
        assert_eq!(
            commands,
            vec![
                ("core.host.start", "host.start"),
                ("core.host.stop.graceful", "host.stop.graceful"),
                ("core.host.restart", "host.restart"),
                ("core.host.reload", "host.reload"),
            ]
        );
        for id in [
            "core.host.start",
            "core.host.stop.graceful",
            "core.host.restart",
            "core.host.reload",
        ] {
            let item = find_item(&group.items, id).unwrap();
            // Host process management is a core-owned tray item, never
            // target=host business RPC.
            assert_eq!(item.action.target, TrayActionTarget::Core);
        }
    }

    #[test]
    fn host_enablement_projects_reducer_acceptance_table() {
        use HostLifecycleState::{Backoff, Failed, Ready, Starting, Stopped, Stopping};
        // Start only from a stopped/failed/backoff host.
        assert!(host_command_enabled(Stopped, "host.start"));
        assert!(host_command_enabled(Failed, "host.start"));
        assert!(host_command_enabled(Backoff, "host.start"));
        assert!(!host_command_enabled(Starting, "host.start"));
        assert!(!host_command_enabled(Ready, "host.start"));
        assert!(!host_command_enabled(Stopping, "host.start"));
        // Graceful stop only while something is running/backing off.
        assert!(!host_command_enabled(Stopped, "host.stop.graceful"));
        assert!(host_command_enabled(Starting, "host.stop.graceful"));
        assert!(host_command_enabled(Ready, "host.stop.graceful"));
        assert!(host_command_enabled(Backoff, "host.stop.graceful"));
        assert!(!host_command_enabled(Stopping, "host.stop.graceful"));
        // Restart accepts stopped/failed/backoff/ready; rejects starting/stopping.
        assert!(!host_command_enabled(Starting, "host.restart"));
        assert!(!host_command_enabled(Stopping, "host.restart"));
        assert!(host_command_enabled(Ready, "host.restart"));
        // Reload is host-cooperative and only meaningful on a Ready host.
        assert!(!host_command_enabled(Stopped, "host.reload"));
        assert!(!host_command_enabled(Starting, "host.reload"));
        assert!(host_command_enabled(Ready, "host.reload"));
        assert!(!host_command_enabled(Stopping, "host.reload"));
        // Unknown command is never enabled.
        assert!(!host_command_enabled(Ready, "host.unknown"));
    }

    #[test]
    fn project_host_items_disables_inapplicable_commands() {
        let snapshot = core_snapshot().normalize().unwrap();
        let ready = HostSnapshot::new();
        let projected = project_host_items(
            snapshot,
            HostSnapshot {
                phase: HostLifecycleState::Ready,
                ..ready
            },
        )
        .normalize()
        .unwrap();
        let group = &projected.groups[0];
        assert!(!find_item(&group.items, "core.host.start").unwrap().enabled);
        assert!(find_item(&group.items, "core.host.reload").unwrap().enabled);
        assert!(
            find_item(&group.items, "core.host.stop.graceful")
                .unwrap()
                .enabled
        );
        // App items are untouched by host projection.
        assert!(
            find_item(&group.items, "core.app.quit.graceful")
                .unwrap()
                .enabled
        );
    }
}
