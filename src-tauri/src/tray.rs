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
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const TRAY_ID: &str = "main-tray";

/// Verdict returned to the host for `shell.tray.setSnapshot`.
#[derive(Clone, Debug, Serialize)]
pub struct TrayPushVerdict {
    pub ok: bool,
    /// Revision the shell currently renders (the accepted one, or the cached
    /// one for an idempotent no-op).
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TrayPushVerdict {
    fn accepted(revision: u64) -> Self {
        Self {
            ok: true,
            revision,
            error: None,
        }
    }

    fn rejected(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            revision: 0,
            error: Some(error.into()),
        }
    }
}

/// Cache of the host/plugin-owned tray groups plus the gate that decides
/// whether an incoming snapshot actually changes the menu.
///
/// The gate is **content-based**, not revision-based. A revision counter cannot
/// work across host restarts: `TrayService` is a fresh process with its own
/// counter (it starts again at 1 and its `generation` is always 0, see
/// host/src/index.ts), so a restarted host's first push would compare
/// `revision(1) <= cached_revision(N)` and be discarded as a replay — the tray
/// would keep the dead process's menu until the new revision climbed past the
/// old peak. Comparing content is restart-proof, order-proof and still makes a
/// duplicate push a no-op.
#[derive(Default)]
struct TrayCache {
    /// Host/plugin-owned groups accepted through `shell.tray.setSnapshot`.
    /// Rust-owned core groups are never taken from the wire.
    groups: Vec<TrayGroup>,
    /// Deterministic serialization of `groups` (serde field order is fixed).
    fingerprint: Option<String>,
    /// Last observed `(generation, revision)`; informational + stale-generation
    /// guard only. The host does not currently send a meaningful generation.
    generation: u64,
    revision: u64,
}

/// What an accepted snapshot did to the cache.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Ingress {
    /// New content: the menu must be re-rendered.
    Changed,
    /// Byte-identical content: idempotent replay, nothing to do.
    Unchanged,
}

impl TrayCache {
    fn fingerprint(groups: &[TrayGroup]) -> Result<String, String> {
        serde_json::to_string(groups).map_err(|err| err.to_string())
    }

    fn accept(&mut self, snapshot: &TrayMenuSnapshot) -> Result<Ingress, String> {
        // A real (non-zero) generation that goes backwards is stale. The host
        // sends 0 today, so this never rejects a legitimate push.
        if snapshot.generation > 0 && snapshot.generation < self.generation {
            return Err("stale tray generation".into());
        }
        let fingerprint = Self::fingerprint(&snapshot.groups)?;
        self.generation = self.generation.max(snapshot.generation);
        self.revision = snapshot.revision;
        if self.fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return Ok(Ingress::Unchanged);
        }
        self.groups = snapshot.groups.clone();
        self.fingerprint = Some(fingerprint);
        Ok(Ingress::Changed)
    }
}

struct TrayInner {
    renderer: TrayRenderer<tauri::Wry>,
    cache: TrayCache,
    /// Serialized form of the last applied merged snapshot. This is the cache:
    /// the tray is re-rendered only when the merged menu actually changes, so
    /// a host lifecycle tick that does not alter enablement costs nothing.
    applied: Option<Value>,
}

pub struct TrayState(Mutex<TrayInner>);

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| route_menu_action(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            // The decision is a pure function (`tray_click_intent`) so the
            // click behaviour is unit-tested; this closure is only the adapter
            // that runs the resulting intent.
            let intent = match &event {
                TrayIconEvent::Click {
                    button,
                    button_state,
                    ..
                } => tray_click_intent(*button, *button_state),
                _ => None,
            };
            if let Some(TrayClickIntent::ShowMainWindow) = intent {
                let _ = show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayState(Mutex::new(TrayInner {
        renderer: TrayRenderer::new(tray),
        cache: TrayCache::default(),
        applied: None,
    })));
    refresh(app).map_err(setup_error)?;
    Ok(())
}

/// Re-render the tray from the cached host groups + the current host
/// lifecycle snapshot.
///
/// Safe to call from any thread (the supervisor calls it on every lifecycle
/// transition): menu mutation is marshalled to the main thread and the merged
/// snapshot is fingerprinted, so an unchanged menu is a no-op.
pub fn refresh(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<TrayState>() else {
        return Ok(());
    };
    let host = app
        .try_state::<HostState>()
        .map(|state| state.lifecycle_snapshot())
        .unwrap_or_else(HostSnapshot::new);
    let merged = {
        let inner = state.0.lock().map_err(|err| err.to_string())?;
        merged_snapshot(&inner.cache.groups, host)?
    };
    let serialized = serde_json::to_value(&merged).map_err(|err| err.to_string())?;
    {
        let inner = state.0.lock().map_err(|err| err.to_string())?;
        if inner.applied.as_ref() == Some(&serialized) {
            return Ok(());
        }
    }

    let main_app = app.clone();
    app.run_on_main_thread(move || {
        let Some(state) = main_app.try_state::<TrayState>() else {
            return;
        };
        let result = (|| -> Result<(), String> {
            let mut inner = state.0.lock().map_err(|err| err.to_string())?;
            if inner.applied.as_ref() == Some(&serialized) {
                return Ok(());
            }
            inner.renderer.apply(merged)?;
            inner.applied = Some(serialized);
            Ok(())
        })();
        if let Err(err) = result {
            eprintln!("[shell] tray refresh: {err}");
        }
    })
    .map_err(|err| err.to_string())
}

/// Validate a host/plugin-owned tray snapshot payload.
///
/// Split out of [`apply_host_snapshot`] so the wire rules can be unit-tested
/// without a running Tauri app. Rejects: anything the JSON Schema rejects
/// (`tray_schema::validate_wire_shape`, generated from the contract), any core
/// group (Rust-owned), and any payload the domain model rejects.
pub(crate) fn validate_host_snapshot(payload: Value) -> Result<TrayMenuSnapshot, String> {
    crate::tray_schema::validate_wire_shape(&payload)?;
    let snapshot: TrayMenuSnapshot =
        serde_json::from_value(payload).map_err(|err| format!("invalid tray snapshot: {err}"))?;
    if snapshot
        .groups
        .iter()
        .any(|group| group.source == TraySource::Core)
    {
        return Err("core tray groups are Rust-owned and cannot be pushed".into());
    }
    // The pushed groups must be valid on their own (ids, labels, targets,
    // nesting) before they are merged with the core groups.
    snapshot.normalize()
}

/// Accept a host/plugin-owned tray snapshot from the host.
///
/// This is the real ingress for the declarative tray contract: the payload is
/// validated against the JSON Schema *and* through the domain model before
/// anything is cached. Core groups are rejected outright — they are Rust-owned
/// and can never be supplied over the wire.
pub fn apply_host_snapshot(app: &AppHandle, payload: Value) -> TrayPushVerdict {
    let Some(state) = app.try_state::<TrayState>() else {
        return TrayPushVerdict::rejected("tray state is not managed");
    };

    let host_only = match validate_host_snapshot(payload) {
        Ok(host_only) => host_only,
        Err(err) => return TrayPushVerdict::rejected(err),
    };

    // Validate the MERGED menu before caching anything: a payload that merges
    // badly (e.g. an id that collides with a core item) must be rejected
    // without poisoning the cache, or every later lifecycle refresh would keep
    // failing on it.
    let host = app
        .try_state::<HostState>()
        .map(|state| state.lifecycle_snapshot())
        .unwrap_or_else(HostSnapshot::new);
    if let Err(err) = merged_snapshot(&host_only.groups, host) {
        return TrayPushVerdict::rejected(err);
    }

    let (ingress, revision) = {
        let mut inner = match state.0.lock() {
            Ok(inner) => inner,
            Err(err) => return TrayPushVerdict::rejected(err.to_string()),
        };
        match inner.cache.accept(&host_only) {
            Ok(ingress) => (ingress, inner.cache.revision),
            Err(err) => return TrayPushVerdict::rejected(err),
        }
    };
    if ingress == Ingress::Unchanged {
        // Idempotent replay: report the rendered revision without re-rendering.
        return TrayPushVerdict::accepted(revision);
    }

    if let Err(err) = refresh(app) {
        return TrayPushVerdict::rejected(err);
    }
    TrayPushVerdict::accepted(revision)
}

/// Merge the Rust-owned core groups with the cached host groups and project the
/// current host lifecycle phase onto the core `host.*` items.
fn merged_snapshot(
    host_groups: &[TrayGroup],
    host: HostSnapshot,
) -> Result<TrayMenuSnapshot, String> {
    let mut snapshot = core_snapshot();
    snapshot.groups.extend(host_groups.iter().cloned());
    project_host_items(snapshot, host).normalize()
}

/// What a tray icon mouse event means to the shell.
///
/// The plugin reports every button and both edges; only one combination is the
/// "show the window" gesture. Extracted from the event closure because a
/// callback handed straight to a GUI toolkit cannot be unit-tested, while this
/// table can.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayClickIntent {
    /// Left button released on the icon: surface the main window.
    ShowMainWindow,
}

/// Decide what a tray icon click means. `None` = the shell ignores it.
///
/// Left + `Up` only: acting on `Down` would fire on press and again on release,
/// and the context menu is bound to the right button.
pub fn tray_click_intent(button: MouseButton, state: MouseButtonState) -> Option<TrayClickIntent> {
    match (button, state) {
        (MouseButton::Left, MouseButtonState::Up) => Some(TrayClickIntent::ShowMainWindow),
        _ => None,
    }
}

/// One window operation used to surface the main window, in execution order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowOp {
    /// Make the window visible.
    Show,
    /// Restore from minimized.
    Unminimize,
    /// Bring to the foreground.
    Focus,
}

/// The operations needed to surface the main window (pure, unit-tested).
///
/// ORDER IS THE CONTRACT: focusing while still minimized leaves the window
/// behind another one, so `Focus` is always last and `Unminimize` (only when
/// the window is actually minimized) sits between show and focus.
pub fn focus_plan(minimized: bool) -> Vec<WindowOp> {
    let mut plan = vec![WindowOp::Show];
    if minimized {
        plan.push(WindowOp::Unminimize);
    }
    plan.push(WindowOp::Focus);
    plan
}

/// Show, restore and focus the main window.
///
/// The single entry point for every "bring the app to the front" path: the tray
/// `core.window.show` item, the tray left click, and the single-instance
/// callback for a second launch.
pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview window not found".to_string())?;
    let minimized = window.is_minimized().map_err(|error| error.to_string())?;
    for op in focus_plan(minimized) {
        match op {
            WindowOp::Show => window.show().map_err(|error| error.to_string())?,
            WindowOp::Unminimize => window.unminimize().map_err(|error| error.to_string())?,
            WindowOp::Focus => window.set_focus().map_err(|error| error.to_string())?,
        }
    }
    Ok(())
}

/// Resolve a tray item id to its rendered label + action.
///
/// The renderer is the only source of truth for which ids exist (host/plugin
/// items included), so every dispatch path — real menu clicks and the dev
/// capability-smoke entry point — resolves through here instead of keeping a
/// second allowlist that would drift from the rendered menu.
fn lookup_action(app: &AppHandle, id: &str) -> Option<(String, TrayAction)> {
    let state = app.try_state::<TrayState>()?;
    let entry = match state.0.lock() {
        Ok(inner) => inner.renderer.action_entry(id),
        Err(err) => {
            // Never swallow this: a poisoned lock would otherwise disable
            // every tray action with no trace.
            eprintln!("[shell] tray action {id}: tray state lock poisoned: {err}");
            None
        }
    };
    entry
}

/// Tray item ids the dev capability-smoke entry point may dispatch.
///
/// Deliberately tiny and non-destructive: a smoke button must never be able to
/// quit the app or stop/restart the host (`core.app.quit.force`,
/// `core.host.*`, `core.app.restart.graceful`). Pinned by test.
pub fn is_smoke_safe_tray_id(id: &str) -> bool {
    matches!(
        id,
        "core.window.show" | "core.window.close" | "core.webview.reload"
    )
}

/// Dispatch one core tray item through the REAL router (issue #6 smoke entry).
///
/// This runs the same [`dispatch_menu_action`] a menu click reaches, so the
/// smoke button exercises the production routing path rather than imitating it.
/// Host/plugin items are unreachable by construction (the allowlist above holds
/// only core window/webview ids).
pub fn dispatch_smoke_item(app: &AppHandle, id: &str) -> Result<(), String> {
    if !is_smoke_safe_tray_id(id) {
        return Err(format!("tray item {id} is not in the smoke allowlist"));
    }
    let Some((_label, action)) = lookup_action(app, id) else {
        return Err(format!("tray item {id} is not currently rendered"));
    };
    dispatch_menu_action(app, id, &action)
}

/// Dev-only readout of the rendered tray (issue #6 smoke panel).
///
/// Reports what the Rust side actually applied, not what a caller hoped: a tray
/// that never got a snapshot renders as zero groups.
pub fn smoke_state(app: &AppHandle) -> Result<Value, String> {
    let Some(state) = app.try_state::<TrayState>() else {
        return Err("tray state is not managed".into());
    };
    let inner = state.0.lock().map_err(|err| err.to_string())?;
    let (groups, items) = match inner.applied.as_ref() {
        Some(applied) => count_snapshot(applied),
        None => (0, 0),
    };
    Ok(json!({ "groups": groups, "items": items }))
}

/// Count the groups and (recursively) the items of a serialized tray snapshot.
///
/// A submenu carries its children under `items`, so counting only the top level
/// would understate the menu the user actually sees.
pub fn count_snapshot(snapshot: &Value) -> (usize, usize) {
    let Some(groups) = snapshot.get("groups").and_then(Value::as_array) else {
        return (0, 0);
    };
    let items = groups
        .iter()
        .map(|group| count_items(group.get("items")))
        .sum();
    (groups.len(), items)
}

fn count_items(items: Option<&Value>) -> usize {
    let Some(items) = items.and_then(Value::as_array) else {
        return 0;
    };
    items
        .iter()
        .map(|item| 1 + count_items(item.get("items")))
        .sum()
}

/// Dispatch one tray menu click to its Rust-owned owner.
///
/// Rust-owned items (`target=core|app`) reach this router only when their id is
/// in the allowlist below; anything else was rejected during normalization.
/// Host/plugin-owned items (`target=host`) are relayed to the host process as a
/// `tray.action` notification carrying the item id, command and `args`.
///
/// Actions flagged `confirm` (or carrying a destructive danger level) ask the
/// user first; the dispatch happens in the dialog callback, so the menu event
/// thread is never blocked.
fn route_menu_action(app: &AppHandle, id: &str) {
    let Some((label, action)) = lookup_action(app, id) else {
        return;
    };

    if action.confirm {
        let prompt = format!(
            "{}?\n\nThis action is marked {:?}.",
            label.trim_end_matches('…'),
            action.danger
        );
        let app_for_dialog = app.clone();
        let id = id.to_string();
        app.dialog()
            .message(prompt)
            .title("Confirm tray action")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Continue".into(),
                "Cancel".into(),
            ))
            .show(move |confirmed| {
                if confirmed {
                    if let Err(error) = dispatch_menu_action(&app_for_dialog, &id, &action) {
                        eprintln!("[shell] tray action {id}: {error}");
                    }
                }
            });
        return;
    }

    if let Err(error) = dispatch_menu_action(app, id, &action) {
        eprintln!("[shell] tray action {id}: {error}");
    }
}

/// Returns the dispatch outcome instead of logging it, so callers decide how to
/// report: the menu path logs it, and the smoke entry point surfaces it in its
/// report (a smoke button that reports success on a failed dispatch would be
/// worse than no smoke at all).
pub(crate) fn dispatch_menu_action(
    app: &AppHandle,
    id: &str,
    action: &TrayAction,
) -> Result<(), String> {
    match (action.target.clone(), action.command.as_str()) {
        // Host/plugin-owned business action: never routed in-process.
        (TrayActionTarget::Host, _) => relay_tray_action(app, id, action),
        (TrayActionTarget::Core, "window.show") => show_main_window(app),
        (TrayActionTarget::Core, "window.close") => hide_main_window(app),
        (TrayActionTarget::Core, "webview.reload") => app
            .get_webview_window("main")
            .ok_or_else(|| "main webview window not found".to_string())
            .and_then(|window| window.reload().map_err(|error| error.to_string())),
        #[cfg(debug_assertions)]
        (TrayActionTarget::Core, "devtools.open") => {
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
                Ok(())
            } else {
                Err("main webview window not found".into())
            }
        }
        (TrayActionTarget::Core, "host.start") => dispatch_host(app, HostCommand::Start),
        (TrayActionTarget::Core, "host.stop.graceful") => {
            dispatch_host(app, HostCommand::GracefulStop)
        }
        (TrayActionTarget::Core, "host.restart") => dispatch_host(app, HostCommand::Restart),
        (TrayActionTarget::Core, "host.reload") => dispatch_host(app, HostCommand::Reload),
        (TrayActionTarget::App, "app.restart.graceful") => {
            dispatch_app(app, AppCommand::RestartGraceful)
        }
        (TrayActionTarget::App, "app.quit.graceful") => dispatch_app(app, AppCommand::QuitGraceful),
        (TrayActionTarget::App, "app.quit.force") => dispatch_app(app, AppCommand::QuitForce),
        _ => Err("tray action is not allowlisted".into()),
    }
}

/// Relay a host/plugin-owned action to the running host.
///
/// Fire-and-forget: the host owns the business handling and reports its own
/// outcome; the shell must not block the menu event thread on it.
fn relay_tray_action(app: &AppHandle, id: &str, action: &TrayAction) -> Result<(), String> {
    let peer = app
        .try_state::<HostState>()
        .and_then(|state| state.peer())
        .ok_or_else(|| "host is not running".to_string())?;
    let payload = serde_json::json!({
        "id": id,
        "command": action.command,
        "args": action.args,
    });
    peer.notify("tray.action", vec![payload])
        .map_err(|err| format!("relay to host failed: {err}"))
}

/// Hide the main window (tray-resident behaviour). Closing the window must not
/// destroy it: `show_main_window` and the tray left-click depend on it.
pub fn hide_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview window not found".to_string())?;
    window.hide().map_err(|error| error.to_string())
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
/// in-flight graceful command. Accepted commands run through the shared
/// Rust-owned orchestration (`crate::execute_app_command`): graceful
/// restart/quit spawn a worker thread, while force quit tears the process tree
/// down synchronously (it is the emergency path and the last thing this thread
/// does).
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

    /// Every action command declared in the core snapshot must be routable by
    /// `route_menu_action`'s allowlist, and every declared action must be
    /// target=Core or target=App (never target=Host business RPC).
    #[test]
    fn core_snapshot_declares_only_routable_allowlisted_commands() {
        let snapshot = core_snapshot().normalize().unwrap();
        let group = &snapshot.groups[0];
        let mut expected: Vec<&str> = vec![
            "window.show",
            "window.close",
            "webview.reload",
            "host.start",
            "host.stop.graceful",
            "host.restart",
            "host.reload",
            "app.restart.graceful",
            "app.quit.graceful",
            "app.quit.force",
        ];
        #[cfg(debug_assertions)]
        expected.push("devtools.open");
        expected.sort_unstable();

        let mut commands: Vec<&str> = group
            .items
            .iter()
            .filter_map(|item| match item {
                TrayItem::Action(action) => Some(action.action.command.as_str()),
                _ => None,
            })
            .collect();
        commands.sort_unstable();
        assert_eq!(
            commands, expected,
            "declared commands must match the router allowlist"
        );

        // No core item may be a host business RPC action.
        for item in &group.items {
            if let TrayItem::Action(action) = item {
                assert_ne!(
                    action.action.target,
                    TrayActionTarget::Host,
                    "core tray items must never target the host RPC bus"
                );
            }
        }
    }

    /// Structural invariants of the fixed bottom group: ids are unique and
    /// `core.`-prefixed, orders are strictly increasing, and every `force`
    /// command is Destructive with confirmation while graceful commands are
    /// Safe without confirmation.
    #[test]
    fn core_snapshot_ids_unique_orders_increasing_and_danger_semantics() {
        let snapshot = core_snapshot().normalize().unwrap();
        let group = &snapshot.groups[0];
        let mut ids = Vec::new();
        let mut orders = Vec::new();
        for item in &group.items {
            if let TrayItem::Action(action) = item {
                assert!(
                    action.id.starts_with("core."),
                    "id {} must be core.*",
                    action.id
                );
                assert!(
                    ids.iter().all(|x| *x != action.id),
                    "duplicate id {}",
                    action.id
                );
                ids.push(action.id.as_str());
                orders.push(action.order);
                let force = action.action.command.ends_with("force");
                assert_eq!(
                    action.action.danger,
                    if force {
                        TrayDanger::Destructive
                    } else {
                        TrayDanger::Safe
                    },
                    "danger of {} must match force semantics",
                    action.id
                );
                assert_eq!(
                    action.action.confirm, force,
                    "confirm of {} must match force",
                    action.id
                );
            }
        }
        let mut sorted = orders.clone();
        sorted.sort_unstable();
        assert_eq!(orders, sorted, "orders must be strictly increasing");
        assert_eq!(
            match group.items.last() {
                Some(TrayItem::Action(action)) => action.id.as_str(),
                _ => "",
            },
            "core.app.quit.force",
            "force quit must remain the absolute last item"
        );
    }

    fn host_group_payload(source: &str, target: &str) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "generation": 1,
            "revision": 7,
            "groups": [{
                "id": "host.demo",
                "order": 10,
                "label": "Demo",
                "visible": true,
                "source": source,
                "items": [{
                    "kind": "action",
                    "id": "host.demo.ping",
                    "order": 0,
                    "label": "Ping",
                    "enabled": true,
                    "visible": true,
                    "action": {
                        "target": target,
                        "command": "demo.ping",
                        "args": [1, "two"],
                        "danger": "safe",
                        "confirm": false
                    }
                }]
            }]
        })
    }

    #[test]
    fn host_snapshot_ingress_is_validated_against_schema_and_model() {
        // A well-formed host payload is accepted and keeps its args/revision.
        let accepted = validate_host_snapshot(host_group_payload("host", "host")).unwrap();
        assert_eq!(accepted.revision, 7);
        assert_eq!(accepted.groups.len(), 1);
        assert_eq!(accepted.groups[0].source, TraySource::Host);
        let TrayItem::Action(item) = &accepted.groups[0].items[0] else {
            panic!("expected action item");
        };
        assert_eq!(item.action.command, "demo.ping");
        assert_eq!(item.action.args.len(), 2);

        // A schema-valid *core* group is still refused: core ownership is
        // Rust-side only, no matter how well-formed the payload is.
        let err = validate_host_snapshot(host_group_payload("core", "core"))
            .expect_err("core groups are Rust-owned");
        assert!(err.contains("Rust-owned"), "{err}");

        // A missing `source` is rejected by the schema-generated type: this is
        // the privilege boundary the model must not default away.
        let mut missing_source = host_group_payload("host", "host");
        missing_source["groups"][0]
            .as_object_mut()
            .unwrap()
            .remove("source");
        assert!(validate_host_snapshot(missing_source).is_err());

        // Unknown fields are rejected (schema `additionalProperties: false`).
        let mut unknown = host_group_payload("host", "host");
        unknown["groups"][0]["unexpected"] = serde_json::json!(true);
        assert!(validate_host_snapshot(unknown).is_err());

        // A host group may not use a core.* id.
        let mut core_id = host_group_payload("host", "host");
        core_id["groups"][0]["id"] = serde_json::json!("core.window.show");
        assert!(validate_host_snapshot(core_id).is_err());

        // A host group may not escalate to a core/app target.
        assert!(validate_host_snapshot(host_group_payload("host", "app")).is_err());
    }

    #[test]
    fn merged_snapshot_orders_host_groups_before_core_and_projects_phase() {
        let host_groups = validate_host_snapshot(host_group_payload("host", "host"))
            .unwrap()
            .groups;
        let ready = HostSnapshot {
            phase: HostLifecycleState::Ready,
            ..HostSnapshot::new()
        };
        let merged = merged_snapshot(&host_groups, ready).unwrap();

        // Host group (order 10) sorts before the core group (order i32::MAX).
        assert_eq!(merged.groups[0].id, "host.demo");
        assert_eq!(merged.groups[0].source, TraySource::Host);
        assert_eq!(merged.groups.last().unwrap().source, TraySource::Core);

        // The projected phase applies to core host items regardless of where
        // the host groups came from.
        let core = merged.groups.last().unwrap();
        assert!(!find_item(&core.items, "core.host.start").unwrap().enabled);
        assert!(find_item(&core.items, "core.host.reload").unwrap().enabled);

        // With no host groups the merged snapshot is exactly the core menu.
        let core_only = merged_snapshot(&[], HostSnapshot::new()).unwrap();
        assert_eq!(core_only.groups.len(), 1);
        assert_eq!(core_only.groups[0].id, "core.controls");
    }

    #[test]
    fn merged_snapshot_rejects_host_items_that_collide_with_core_ids() {
        // A host group may not reuse a core item id: the merge must fail so the
        // ingress rejects the payload BEFORE caching it (a cached bad payload
        // would make every later lifecycle refresh fail too).
        let mut groups = validate_host_snapshot(host_group_payload("host", "host"))
            .unwrap()
            .groups;
        groups[0].items[0] = TrayItem::Action(TrayActionItem {
            id: "core.window.show".into(),
            order: 0,
            label: "Shadow".into(),
            enabled: true,
            visible: true,
            action: TrayAction {
                target: TrayActionTarget::Host,
                command: "shadow".into(),
                args: vec![],
                danger: TrayDanger::Safe,
                confirm: false,
            },
        });
        let err =
            merged_snapshot(&groups, HostSnapshot::new()).expect_err("colliding id must not merge");
        assert!(err.contains("duplicate id"), "{err}");
    }

    #[test]
    fn restarted_host_content_is_never_mistaken_for_a_replay() {
        // Regression (three-agent review, [severe]): the gate used to be
        // `generation == cached && revision <= cached_revision`. A restarted
        // host is a NEW process whose revision counter starts at 1 again and
        // whose generation is always 0 (host/src/index.ts passes none), so its
        // first push after a long-lived predecessor was accepted-but-ignored:
        // the tray kept the dead process's menu until the new revision climbed
        // past the old peak. Content equality is restart-proof.
        let mut cache = TrayCache::default();

        let first = validate_host_snapshot(host_group_payload("host", "host")).unwrap();
        assert_eq!(first.revision, 7);
        assert_eq!(cache.accept(&first).unwrap(), Ingress::Changed);
        // A duplicate push of identical content stays a no-op.
        assert_eq!(cache.accept(&first).unwrap(), Ingress::Unchanged);

        // Restarted host: revision back to 1, same (always 0) generation, but
        // different content — must be applied.
        let mut restarted = first.clone();
        restarted.revision = 1;
        restarted.groups[0].label = Some("After restart".into());
        assert_eq!(cache.accept(&restarted).unwrap(), Ingress::Changed);
        assert_eq!(cache.groups[0].label.as_deref(), Some("After restart"));
        assert_eq!(cache.revision, 1);

        // Identical content from the restarted host is still a no-op.
        let mut same_after_restart = restarted.clone();
        same_after_restart.revision = 1;
        assert_eq!(
            cache.accept(&same_after_restart).unwrap(),
            Ingress::Unchanged
        );

        // A real backwards generation is still rejected.
        let mut newer = restarted.clone();
        newer.generation = 9;
        cache.accept(&newer).unwrap();
        newer.generation = 3;
        assert!(cache.accept(&newer).is_err());
    }

    #[test]
    fn core_snapshot_keeps_the_confirm_semantics_the_router_consumes() {
        // route_menu_action shows a dialog when `confirm` is set; the core
        // force actions must keep it so the destructive path stays guarded.
        let snapshot = core_snapshot().normalize().unwrap();
        let force = find_item(&snapshot.groups[0].items, "core.app.quit.force").unwrap();
        assert!(force.action.confirm);
        assert_eq!(force.action.danger, TrayDanger::Destructive);
        let graceful = find_item(&snapshot.groups[0].items, "core.app.quit.graceful").unwrap();
        assert!(!graceful.action.confirm);
    }

    #[test]
    fn tray_click_intent_is_left_release_only() {
        // The one gesture that surfaces the window.
        assert_eq!(
            tray_click_intent(MouseButton::Left, MouseButtonState::Up),
            Some(TrayClickIntent::ShowMainWindow)
        );
        // Press-down must not act, or a single click would fire twice.
        assert_eq!(
            tray_click_intent(MouseButton::Left, MouseButtonState::Down),
            None
        );
        // Right button belongs to the context menu.
        assert_eq!(
            tray_click_intent(MouseButton::Right, MouseButtonState::Up),
            None
        );
        assert_eq!(
            tray_click_intent(MouseButton::Middle, MouseButtonState::Up),
            None
        );
    }

    #[test]
    fn focus_plan_orders_show_then_unminimize_then_focus() {
        // A visible window needs no unminimize step.
        assert_eq!(focus_plan(false), vec![WindowOp::Show, WindowOp::Focus]);
        // A minimized one does — and it must come BEFORE the focus, otherwise
        // the window stays behind whatever is in front.
        assert_eq!(
            focus_plan(true),
            vec![WindowOp::Show, WindowOp::Unminimize, WindowOp::Focus]
        );
    }

    #[test]
    fn smoke_allowlist_excludes_every_destructive_core_item() {
        // Allowed: non-destructive window/webview items.
        for id in [
            "core.window.show",
            "core.window.close",
            "core.webview.reload",
        ] {
            assert!(is_smoke_safe_tray_id(id), "{id} must be smoke-safe");
        }
        // Rejected: anything that stops the host or quits the app, and every
        // host/plugin-owned id (those are business RPC, not smoke).
        for id in [
            "core.app.quit.force",
            "core.app.quit.graceful",
            "core.app.restart.graceful",
            "core.host.stop.graceful",
            "core.host.restart",
            "core.host.start",
            "core.host.reload",
            "core.devtools.open",
            "plugin.some.action",
            "",
        ] {
            assert!(!is_smoke_safe_tray_id(id), "{id} must NOT be smoke-safe");
        }
        // Every allowlisted id is a real core item, so the allowlist cannot
        // point at something the menu never renders.
        let snapshot = core_snapshot().normalize().unwrap();
        for id in [
            "core.window.show",
            "core.window.close",
            "core.webview.reload",
        ] {
            assert!(find_item(&snapshot.groups[0].items, id).is_some(), "{id}");
        }
    }

    #[test]
    fn count_snapshot_counts_groups_and_nested_items() {
        // No snapshot applied yet: an empty tray, not an error.
        assert_eq!(count_snapshot(&Value::Null), (0, 0));
        assert_eq!(count_snapshot(&json!({})), (0, 0));

        let snapshot = json!({
            "groups": [
                { "items": [{ "id": "a" }, { "id": "b" }] },
                { "items": [{ "id": "c" }] }
            ]
        });
        assert_eq!(count_snapshot(&snapshot), (2, 3));

        // A submenu's children are real rows the user sees: they count.
        let nested = json!({
            "groups": [
                { "items": [ { "id": "parent", "items": [{ "id": "child" }] } ] }
            ]
        });
        assert_eq!(count_snapshot(&nested), (1, 2));
    }
}
