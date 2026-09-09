// M1-1: Rust-owned system tray setup, core menu declaration and routing.

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
    renderer.apply(core_snapshot()).map_err(setup_error)?;
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
        Some((TrayActionTarget::App, "app.quit.force")) => {
            app.exit(0);
            Ok(())
        }
        Some((TrayActionTarget::App, "app.restart.graceful" | "app.quit.graceful")) => {
            Err("app lifecycle facade not connected".into())
        }
        Some(_) => Err("tray action is not allowlisted".into()),
        None => return,
    };
    if let Err(error) = result {
        eprintln!("[shell] tray action {id}: {error}");
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
    items.extend([
        core_action(
            "core.app.restart.graceful",
            100,
            "Restart Application",
            "app.restart.graceful",
            TrayActionTarget::App,
            false,
        ),
        core_action(
            "core.app.quit.graceful",
            110,
            "Quit",
            "app.quit.graceful",
            TrayActionTarget::App,
            false,
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
        let graceful = group
            .items
            .iter()
            .find_map(|item| match item {
                TrayItem::Action(item) if item.id == "core.app.restart.graceful" => Some(item),
                _ => None,
            })
            .unwrap();
        assert!(
            !graceful.enabled,
            "must stay disabled until the app lifecycle facade is connected"
        );
    }
}
