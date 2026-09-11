// M1-1: global shortcut callback (issue #6, "注册/反注册 + 回调").
//
// Registration already existed (`shell.shortcut.register/unregister/
// isRegistered`) but a PRESS went nowhere: the plugin was built without a
// handler, so a registered chord had no observable effect and the acceptance
// item "快捷键触发" could not be met.
//
// Layering — and why it is split exactly here:
//   - [`ShortcutRegistry::route`] is the PURE decision "does the shell owe the
//     host a notification for this event?". Everything about it (only chords
//     the shell registered, only the key-down edge, canonical spelling) is
//     unit-tested with no Tauri app: the plugin's `Shortcut` is a plain value
//     type (`Copy + Eq + Hash`) and its parser folds case, so the same physical
//     chord spelled `ctrl+shift+k` or `Ctrl+Shift+K` is ONE registry key.
//   - [`on_event`] is the thin adapter: route → `shortcut.pressed` over
//     kkrpc/stdio → a `shortcut-pressed` Tauri event carrying the delivery
//     verdict, so the dev smoke panel can SEE the callback fire instead of
//     trusting a log line.
//
// The canonical spelling (`into_string()`, e.g. `shift+control+KeyK`) is
// produced ONLY here. Neither the host nor the frontend re-parse an
// accelerator: `shell.shortcut.register` returns the canonical string and a
// press event carries the same string, so chord identity has one
// implementation. (Verified 2026-09: `global_hotkey::hotkey::HotKey` stores the
// resolved platform modifiers, and `Code`'s `Display` keeps the variant
// spelling, so `into_string()` is deterministic per platform.)

use crate::kkrpc_peer::Peer;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState as KeyState};

/// One press the shell decided to forward to the host.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ShortcutPress {
    /// Canonical chord spelling (the plugin's `into_string()`).
    pub accelerator: String,
    /// Plugin hotkey id: `(modifiers.bits() << 16) | key`.
    pub id: u32,
}

/// Reply shape of `shell.shortcut.register` / `shell.shortcut.unregister`.
///
/// Carries the canonical spelling so the caller never has to re-implement
/// accelerator parsing to know which chord its callback will be matched
/// against.
#[derive(Clone, Debug, Serialize)]
pub struct ShortcutRegistration {
    pub ok: bool,
    /// Canonical spelling, present whenever the chord could be parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accelerator: Option<String>,
    /// Why the shell refused, when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ShortcutRegistration {
    /// The shell accepted the chord (parsed + handed to the OS).
    pub fn accepted(shortcut: Shortcut) -> Self {
        Self {
            ok: true,
            accelerator: Some(canonical(shortcut)),
            error: None,
        }
    }

    /// The shell refused it; `error` is shown to the caller.
    pub fn rejected(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            accelerator: None,
            error: Some(error.into()),
        }
    }
}

/// Canonical, platform-specific chord spelling (`shift+control+KeyK`).
///
/// `CommandOrControl` is resolved per platform inside the plugin's parser, so
/// this is the one place a chord's identity is spelled out.
pub fn canonical(shortcut: Shortcut) -> String {
    shortcut.into_string()
}

/// Parse a wire accelerator into the plugin's value type.
///
/// The error is the parser's own message (e.g. `Ctrl+Shift` has no main key),
/// which is what the caller needs to fix the request.
pub fn parse_accelerator(input: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(input).map_err(|err| err.to_string())
}

/// Mirror of the chords the shell has actually registered with the OS.
///
/// The registry is a *mirror*, never a second source of truth: see
/// [`sync_from_plugin`]. It exists because the plugin's own store is private,
/// and because only the shell — not the host, not the UI — may decide that a
/// press is worth a notification.
#[derive(Default)]
pub struct ShortcutRegistry {
    registered: HashSet<Shortcut>,
}

impl ShortcutRegistry {
    /// Record a chord. Returns `false` when it was already recorded, so a
    /// repeated register is idempotent instead of a double binding.
    pub fn insert(&mut self, shortcut: Shortcut) -> bool {
        self.registered.insert(shortcut)
    }

    /// Forget a chord. Returns `false` when it was not recorded.
    pub fn remove(&mut self, shortcut: &Shortcut) -> bool {
        self.registered.remove(shortcut)
    }

    pub fn contains(&self, shortcut: &Shortcut) -> bool {
        self.registered.contains(shortcut)
    }

    pub fn len(&self) -> usize {
        self.registered.len()
    }

    /// The pure routing decision.
    ///
    /// `None` means "the shell owes nobody anything":
    ///   - the chord is not registered here — an unregistered, already
    ///     unregistered, or OS-refused chord must never fire;
    ///   - the event is the key-UP edge — the plugin reports both edges, and
    ///     forwarding both would run every handler twice per keypress.
    pub fn route(&self, shortcut: &Shortcut, state: KeyState) -> Option<ShortcutPress> {
        if state != KeyState::Pressed {
            return None;
        }
        if !self.contains(shortcut) {
            return None;
        }
        Some(ShortcutPress {
            accelerator: canonical(*shortcut),
            id: shortcut.id(),
        })
    }
}

/// Tauri-managed shortcut registry.
#[derive(Default)]
pub struct ManagedShortcuts(std::sync::Mutex<ShortcutRegistry>);

impl ManagedShortcuts {
    /// Run `f` against the registry.
    ///
    /// A poisoned lock is reported and yields `None`, never an empty registry:
    /// silently pretending "nothing is registered" would turn a panic into a
    /// permanently dead shortcut callback with no trace.
    fn with<R>(&self, f: impl FnOnce(&mut ShortcutRegistry) -> R) -> Option<R> {
        match self.0.lock() {
            Ok(mut guard) => Some(f(&mut guard)),
            Err(err) => {
                eprintln!("[shell] shortcut registry lock poisoned: {err}");
                None
            }
        }
    }
}

/// Mirror the plugin's authoritative registration state into the registry.
///
/// Called after every `register`/`unregister` the shell performs, so the mirror
/// cannot drift: a chord the plugin refused (already taken by another
/// application) is never forwarded, and a chord the plugin dropped stops
/// firing immediately.
pub fn sync_from_plugin(app: &AppHandle, shortcut: Shortcut) {
    let registered = app.global_shortcut().is_registered(shortcut);
    let Some(state) = app.try_state::<ManagedShortcuts>() else {
        return; // no registry managed in this context: nothing to mirror
    };
    state.with(|registry| {
        if registered {
            registry.insert(shortcut);
        } else {
            registry.remove(&shortcut);
        }
    });
}

/// Register a chord with the OS and mirror the outcome into the registry.
///
/// The single implementation behind both `shell.shortcut.register` and the
/// smoke entry point: the canonical reply and the mirror rule must not diverge
/// between the host-facing capability and the dev button.
pub fn register_with_os(app: &AppHandle, shortcut: Shortcut) -> ShortcutRegistration {
    let ok = app.global_shortcut().register(shortcut).is_ok();
    // Mirror either way: a chord the OS refused (already taken by another
    // application) must never be forwarded as a press.
    sync_from_plugin(app, shortcut);
    if ok {
        ShortcutRegistration::accepted(shortcut)
    } else {
        ShortcutRegistration::rejected(
            "the operating system refused the accelerator (is it in use by another application?)",
        )
    }
}

/// Unregister a chord and mirror the outcome into the registry.
pub fn unregister_with_os(app: &AppHandle, shortcut: Shortcut) -> ShortcutRegistration {
    let result = app.global_shortcut().unregister(shortcut);
    // State-based mirror: after the call the plugin is the authority on whether
    // this chord is still live.
    sync_from_plugin(app, shortcut);
    match result {
        Ok(()) => ShortcutRegistration::accepted(shortcut),
        Err(err) => ShortcutRegistration::rejected(err.to_string()),
    }
}

/// How many chords are currently mirrored as registered.
///
/// Dev readout for the capability smoke panel: it makes the registry visible
/// instead of leaving "did the registration actually stick?" to guesswork.
/// `None` when no registry is managed in this context.
pub fn registered_count(app: &AppHandle) -> Option<usize> {
    let state = app.try_state::<ManagedShortcuts>()?;
    state.with(|registry| registry.len())
}

/// How a press fared on its way to the host.
///
/// A bare `bool` was not enough: "no host process" and "the host pipe is gone"
/// are different faults with different fixes, yet the dev panel could only say
/// "not delivered", which reads like a shell bug either way.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Delivery {
    /// The frame was written to the host's stdin.
    Delivered,
    /// No host process is adopted right now (never started, still starting, or
    /// already reaped).
    NoHost,
    /// A host was adopted but the frame could not be written (dead pipe).
    WriteFailed(String),
}

impl Delivery {
    /// Stable wire code for the dev event.
    pub fn code(&self) -> &'static str {
        match self {
            Delivery::Delivered => "delivered",
            Delivery::NoHost => "no-host",
            Delivery::WriteFailed(_) => "write-failed",
        }
    }

    /// Extra context for the panel, when there is any.
    pub fn detail(&self) -> Option<&str> {
        match self {
            Delivery::Delivered | Delivery::NoHost => None,
            Delivery::WriteFailed(err) => Some(err),
        }
    }
}

/// One-line summary of the host's own state, for the dev event and the smoke
/// registration replies.
///
/// Without this a caller can only guess why delivery failed; with it the answer
/// ("host is Failed: <reason>") travels with the press — and the smoke panel can
/// warn BEFORE a chord is pressed that nothing is listening.
pub(crate) fn host_view(app: &AppHandle) -> Option<Value> {
    let state = app.try_state::<crate::host::HostState>()?;
    let snapshot = state.lifecycle_snapshot();
    Some(json!({
        "phase": snapshot.phase,
        "pid": snapshot.pid,
        "lastError": snapshot.last_error,
    }))
}

/// True when a host process is adopted right now, so a press can reach it.
pub fn host_available(app: &AppHandle) -> bool {
    app.try_state::<crate::host::HostState>()
        .and_then(|state| state.peer())
        .is_some()
}

/// Plugin handler for EVERY shortcut the shell registered.
///
/// Runs on the plugin's global event thread, so it must not block: the host
/// notification is fire-and-forget (`Peer::notify`) and the webview event is a
/// plain emit.
pub fn on_event(
    app: &AppHandle,
    shortcut: &Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    let Some(press) = route_in_app(app, shortcut, event.state) else {
        return;
    };
    let delivery = notify_host(app, &press);
    emit_press(app, &press, delivery);
}

fn route_in_app(app: &AppHandle, shortcut: &Shortcut, state: KeyState) -> Option<ShortcutPress> {
    let registry = app.try_state::<ManagedShortcuts>()?;
    registry
        .with(|registry| registry.route(shortcut, state))
        .flatten()
}

/// Forward one press to the host over kkrpc/stdio.
///
/// The result distinguishes the two faults that used to collapse into one
/// "not delivered" message (see [`Delivery`]).
fn notify_host(app: &AppHandle, press: &ShortcutPress) -> Delivery {
    let Some(peer) = app
        .try_state::<crate::host::HostState>()
        .and_then(|state| state.peer())
    else {
        return Delivery::NoHost;
    };
    match notify_press(&peer, press) {
        Ok(()) => Delivery::Delivered,
        Err(err) => Delivery::WriteFailed(err),
    }
}

/// Wire payload of `shortcut.pressed`; mirrored by `host/src/stdio.ts`.
pub fn press_payload(press: &ShortcutPress) -> Value {
    json!({ "accelerator": press.accelerator, "id": press.id })
}

fn notify_press(peer: &Arc<Peer>, press: &ShortcutPress) -> Result<(), String> {
    peer.notify("shortcut.pressed", vec![press_payload(press)])
}

/// Dev event payload for one press (pure, unit-tested).
pub fn press_event_payload(
    press: &ShortcutPress,
    delivery: &Delivery,
    host: Option<Value>,
) -> Value {
    json!({
        "accelerator": press.accelerator,
        "id": press.id,
        "delivery": delivery.code(),
        "detail": delivery.detail(),
        "host": host,
    })
}

/// Dev observability: mirror the press into the webview so the capability smoke
/// panel can show that the shell-side callback fired, and WHY the frame did or
/// did not reach the host. Never a business path — the host owns the meaning of
/// a chord.
fn emit_press(app: &AppHandle, press: &ShortcutPress, delivery: Delivery) {
    let payload = press_event_payload(press, &delivery, host_view(app));
    if let Err(err) = app.emit("shortcut-pressed", payload) {
        eprintln!("[shell] emit shortcut-pressed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse helper. Named so it cannot shadow a local `chord` binding.
    fn chord_of(input: &str) -> Shortcut {
        parse_accelerator(input).unwrap_or_else(|err| panic!("parse {input}: {err}"))
    }

    #[test]
    fn parsing_folds_case_and_spacing_so_one_chord_is_one_key() {
        // This is what makes a chord registered as `CommandOrControl+Shift+K`
        // match the press the plugin reports for the same physical keys.
        assert_eq!(chord_of("Ctrl+Shift+K"), chord_of("ctrl+shift+k"));
        assert_eq!(chord_of("Ctrl+Shift+K"), chord_of("CTRL + SHIFT + K"));
        assert_eq!(chord_of("Ctrl+Shift+K"), chord_of("Control+Shift+keyk"));
        // Modifier aliases.
        assert_eq!(chord_of("Cmd+K"), chord_of("Super+K"));
        assert_eq!(chord_of("Option+K"), chord_of("Alt+K"));
    }

    #[test]
    fn command_or_control_resolves_to_this_platforms_modifier() {
        let resolved = chord_of("CommandOrControl+Shift+K");
        #[cfg(target_os = "macos")]
        assert_eq!(resolved, chord_of("Super+Shift+K"));
        #[cfg(not(target_os = "macos"))]
        assert_eq!(resolved, chord_of("Ctrl+Shift+K"));
        let _ = resolved;
    }

    #[test]
    fn canonical_spelling_is_stable_and_is_what_the_wire_carries() {
        let canonical_ctrl_shift_k = canonical(chord_of("Shift+Ctrl+K"));
        // Modifier order is fixed by the plugin, so two spellings of one chord
        // produce the identical wire string.
        assert_eq!(canonical_ctrl_shift_k, canonical(chord_of("Ctrl+Shift+K")));
        assert!(
            canonical_ctrl_shift_k.starts_with("shift+control+"),
            "{canonical_ctrl_shift_k}"
        );
        assert!(
            canonical_ctrl_shift_k.ends_with("KeyK"),
            "{canonical_ctrl_shift_k}"
        );
    }

    #[test]
    fn route_forwards_only_registered_key_down_edges() {
        let mut registry = ShortcutRegistry::default();
        let chord = chord_of("Ctrl+Shift+K");
        assert_eq!(registry.len(), 0);
        // Not registered yet: the press is not the shell's business.
        assert_eq!(registry.route(&chord, KeyState::Pressed), None);

        assert!(registry.insert(chord));
        let press = registry
            .route(&chord, KeyState::Pressed)
            .expect("a registered press routes");
        assert_eq!(press.accelerator, canonical(chord));
        assert_eq!(press.id, chord.id());

        // The key-up edge must never fire a second time.
        assert_eq!(registry.route(&chord, KeyState::Released), None);
        // A chord nobody registered stays silent.
        assert_eq!(
            registry.route(&chord_of("Ctrl+Shift+J"), KeyState::Pressed),
            None
        );
    }

    #[test]
    fn insert_and_remove_are_idempotent_and_routing_follows() {
        let mut registry = ShortcutRegistry::default();
        let chord = chord_of("Ctrl+Shift+K");
        assert!(registry.insert(chord), "first insert records the chord");
        assert!(!registry.insert(chord), "second insert is a no-op");
        assert_eq!(registry.len(), 1);

        assert!(registry.remove(&chord), "removal reports the entry");
        assert!(!registry.remove(&chord), "second removal is a no-op");
        assert_eq!(registry.len(), 0);
        // After removal the chord must go silent again.
        assert_eq!(registry.route(&chord, KeyState::Pressed), None);
    }

    #[test]
    fn press_payload_matches_the_host_contract() {
        let press = ShortcutPress {
            accelerator: "shift+control+KeyK".into(),
            id: 7,
        };
        assert_eq!(
            press_payload(&press),
            json!({ "accelerator": "shift+control+KeyK", "id": 7 })
        );
    }

    #[test]
    fn delivery_reports_the_fault_not_just_a_boolean() {
        assert_eq!(Delivery::Delivered.code(), "delivered");
        assert_eq!(Delivery::Delivered.detail(), None);

        let no_host = Delivery::NoHost;
        assert_eq!(no_host.code(), "no-host");
        assert_eq!(no_host.detail(), None);

        let broken = Delivery::WriteFailed("host stdio closed".into());
        assert_eq!(broken.code(), "write-failed");
        assert_eq!(broken.detail(), Some("host stdio closed"));
        // The three outcomes must stay distinguishable: collapsing them into a
        // boolean is exactly what made the acceptance run hard to diagnose.
        assert_ne!(broken.code(), no_host.code());
        assert_ne!(no_host.code(), Delivery::Delivered.code());
    }

    #[test]
    fn press_event_payload_carries_the_reason_and_the_host_state() {
        let press = ShortcutPress {
            accelerator: "shift+control+KeyK".into(),
            id: 9,
        };
        // No host adopted: the panel gets the code plus whatever host state the
        // shell can see (null when the state is not managed at all).
        assert_eq!(
            press_event_payload(&press, &Delivery::NoHost, None),
            json!({
                "accelerator": "shift+control+KeyK",
                "id": 9,
                "delivery": "no-host",
                "detail": null,
                "host": null,
            })
        );
        // A host that is up but whose pipe is gone.
        let payload = press_event_payload(
            &press,
            &Delivery::WriteFailed("host stdio closed".into()),
            Some(json!({ "phase": "ready", "pid": 4242, "lastError": null })),
        );
        assert_eq!(payload["delivery"], json!("write-failed"));
        assert_eq!(payload["detail"], json!("host stdio closed"));
        assert_eq!(payload["host"]["phase"], json!("ready"));
        assert_eq!(payload["host"]["pid"], json!(4242));
    }

    #[test]
    fn registration_replies_carry_the_canonical_spelling_or_a_reason() {
        let chord = chord_of("Ctrl+Shift+K");
        let accepted = ShortcutRegistration::accepted(chord);
        assert!(accepted.ok);
        assert_eq!(
            accepted.accelerator.as_deref(),
            Some(canonical(chord).as_str())
        );
        assert!(accepted.error.is_none());

        let rejected = ShortcutRegistration::rejected("bad chord");
        assert!(!rejected.ok);
        assert!(rejected.accelerator.is_none());
        assert_eq!(rejected.error.as_deref(), Some("bad chord"));
    }

    #[test]
    fn a_bad_accelerator_reports_the_parser_message() {
        let no_main_key = parse_accelerator("Ctrl+Shift").expect_err("no main key");
        assert!(!no_main_key.is_empty(), "{no_main_key}");
        let empty = parse_accelerator("").expect_err("empty chord");
        assert!(!empty.is_empty(), "{empty}");
        // Two main keys is also rejected rather than silently picking one.
        assert!(parse_accelerator("Ctrl+K+J").is_err());
    }
}
