// M1-1: unified capability smoke entry point (issue #6, dev affordance).
//
// Issue #6's last task is ONE place that exercises the five system capabilities
// (tray / single-instance / shortcut / notification / dialog) so the manual
// acceptance run is a checklist instead of ad-hoc poking. The face half is
// `src/capabilitySmokePanel.tsx` (dev builds only); this is the Rust half.
//
// Layering — the split exists so the interesting parts are testable:
//   - everything DECIDABLE is pure and unit-tested in this file's `tests` (and
//     in `dialog_opts` / `tray`): the request parser, the smoke tray allowlist,
//     notification defaults, the second-instance command line, snapshot
//     counting. None of it needs an `AppHandle`.
//   - the OS effects are one-line adapters. The parts that genuinely cannot be
//     automated (clicking a tray icon, seeing a toast appear, a second process
//     focusing the first window) are described as INSTRUCTIONS in the panel
//     instead of being faked here.
//
// Scope discipline: this module is reachable from the webview like any other
// command, so every action it can perform is either read-only or
// non-destructive. Tray dispatch goes through the allowlist in
// `tray::is_smoke_safe_tray_id` — a smoke button must never be able to quit the
// app or stop the host.

use crate::dialog_opts;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Default 标题/正文 for the notification smoke.
///
/// Empty input is a missing input: the smoke must still produce a visible
/// notification rather than an empty toast that proves nothing.
pub fn notify_defaults(title: Option<&str>, body: Option<&str>) -> (String, String) {
    (
        title
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("VRCX-K")
            .to_string(),
        body.filter(|value| !value.trim().is_empty())
            .unwrap_or("通知 smoke：看到这条系统通知即说明 L1 原生通知链路已通。")
            .to_string(),
    )
}

/// The program a second-instance smoke must launch.
///
/// The running binary itself — never a path derived from the resolved host
/// launch spec: a second instance has to be the same application (in dev that
/// is the cargo/tauri binary, not the bundled host sidecar).
pub fn second_instance_program(current_exe: Option<PathBuf>) -> Result<PathBuf, String> {
    current_exe.ok_or_else(|| "current_exe() is unavailable; cannot relaunch this app".to_string())
}

/// Build the real second launch: the same executable with no arguments, which
/// is exactly what a user launching the app twice produces. Nothing is
/// simulated — the second process boots the real single-instance plugin, which
/// notifies the running instance and exits.
pub fn second_instance_command(program: &Path) -> Command {
    Command::new(program)
}

/// The dev smoke request (face → shell).
///
/// Wire spelling is camelCase (`{"action":"trayDispatch","id":"..."}`);
/// `parse_action` rejects anything else rather than guessing, so a frontend
/// typo surfaces as an error instead of a silently ignored click.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SmokeAction {
    /// L1 native notification (official plugin, cross-platform).
    Notify {
        title: Option<String>,
        body: Option<String>,
    },
    /// Modal message box; reports which button was pressed.
    DialogMessage {
        text: Option<String>,
        kind: Option<String>,
        buttons: Option<String>,
    },
    /// Modal question; reports the raw button label.
    DialogAsk {
        text: Option<String>,
        buttons: Option<String>,
    },
    /// Native open/save picker.
    DialogPickFile {
        save: Option<bool>,
        directory: Option<bool>,
        multiple: Option<bool>,
    },
    /// Re-render the tray from the current lifecycle snapshot and report what
    /// the Rust side actually applied.
    #[cfg(desktop)]
    TrayRender,
    /// Dispatch one allowlisted core tray item through the real router.
    #[cfg(desktop)]
    TrayDispatch { id: String },
    /// Register a chord and report its canonical spelling to press.
    #[cfg(desktop)]
    ShortcutRegister { accelerator: String },
    /// Release a chord.
    #[cfg(desktop)]
    ShortcutUnregister { accelerator: String },
    /// Launch the app a second time (the real single-instance path).
    SecondInstance,
}

impl SmokeAction {
    /// Which of the five capabilities this action exercises; the panel groups
    /// its results by this label.
    pub fn capability(&self) -> &'static str {
        match self {
            SmokeAction::Notify { .. } => "notification",
            SmokeAction::DialogMessage { .. }
            | SmokeAction::DialogAsk { .. }
            | SmokeAction::DialogPickFile { .. } => "dialog",
            #[cfg(desktop)]
            SmokeAction::TrayRender | SmokeAction::TrayDispatch { .. } => "tray",
            #[cfg(desktop)]
            SmokeAction::ShortcutRegister { .. } | SmokeAction::ShortcutUnregister { .. } => {
                "shortcut"
            }
            SmokeAction::SecondInstance => "single-instance",
        }
    }
}

/// Outcome of one smoke action.
#[derive(Clone, Debug, Serialize)]
pub struct SmokeReport {
    /// Capability label (`tray`, `single-instance`, `shortcut`, `notification`,
    /// `dialog`, or `unknown` for an unparsable request).
    pub capability: &'static str,
    pub ok: bool,
    /// Human-readable outcome, shown verbatim in the panel.
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SmokeReport {
    pub fn ok(capability: &'static str, detail: impl Into<String>) -> Self {
        Self {
            capability,
            ok: true,
            detail: detail.into(),
            value: None,
            error: None,
        }
    }

    pub fn ok_with(capability: &'static str, detail: impl Into<String>, value: Value) -> Self {
        Self {
            value: Some(value),
            ..Self::ok(capability, detail)
        }
    }

    pub fn failed(capability: &'static str, error: impl Into<String>) -> Self {
        let error = error.into();
        Self {
            capability,
            ok: false,
            detail: error.clone(),
            value: None,
            error: Some(error),
        }
    }
}

/// Parse a smoke request.
///
/// Split from the command so the accepted wire shape is unit-tested without a
/// Tauri app.
pub fn parse_action(raw: &Value) -> Result<SmokeAction, String> {
    serde_json::from_value::<SmokeAction>(raw.clone()).map_err(|err| err.to_string())
}

/// Run one blocking dialog off the runtime's worker threads.
///
/// The dialog plugin's `blocking_*` API must never run on the event-loop
/// thread (it would wait for a result that only the event loop can deliver).
/// `shell.*` handlers are already off it (they run on the stdio reader thread);
/// an async command is not, hence this hop.
async fn off_thread<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("smoke task failed: {err}"))
}

async fn dialog_message(
    app: AppHandle,
    text: Option<String>,
    kind: Option<String>,
    buttons: Option<String>,
) -> SmokeReport {
    let capability = "dialog";
    let text = text.unwrap_or_else(|| "VRCX-K 对话框 smoke：点 OK 结束。".to_string());
    let kind = dialog_opts::message_kind(kind.as_deref());
    let buttons = dialog_opts::message_buttons(buttons.as_deref());
    let owner = app.clone();
    match off_thread(move || {
        owner
            .dialog()
            .message(text)
            .kind(kind)
            .buttons(buttons)
            .blocking_show()
    })
    .await
    {
        Ok(confirmed) => SmokeReport::ok_with(
            capability,
            format!(
                "消息框已返回：{}",
                if confirmed { "确认" } else { "取消/关闭" }
            ),
            json!({ "confirmed": confirmed }),
        ),
        Err(err) => SmokeReport::failed(capability, format!("打开消息框失败：{err}")),
    }
}

async fn dialog_ask(app: AppHandle, text: Option<String>, buttons: Option<String>) -> SmokeReport {
    let capability = "dialog";
    let text = text.unwrap_or_else(|| "VRCX-K 询问框 smoke：请选一个按钮。".to_string());
    let buttons = dialog_opts::message_buttons(buttons.as_deref());
    let owner = app.clone();
    match off_thread(move || {
        owner
            .dialog()
            .message(text)
            .buttons(buttons)
            .blocking_show_with_result()
    })
    .await
    {
        Ok(result) => {
            let label = match result {
                tauri_plugin_dialog::MessageDialogResult::Yes => "yes",
                tauri_plugin_dialog::MessageDialogResult::No => "no",
                tauri_plugin_dialog::MessageDialogResult::Ok => "ok",
                tauri_plugin_dialog::MessageDialogResult::Cancel => "cancel",
                _ => "unknown",
            };
            SmokeReport::ok_with(
                capability,
                format!("询问框返回：{label}"),
                json!({ "result": label }),
            )
        }
        Err(err) => SmokeReport::failed(capability, format!("打开询问框失败：{err}")),
    }
}

async fn dialog_pick_file(
    app: AppHandle,
    save: bool,
    directory: bool,
    multiple: bool,
) -> SmokeReport {
    let capability = "dialog";
    let owner = app.clone();
    // The precedence table is shared with `shell.dialog.pickFile`; only the
    // plugin calls differ (its builder is generic over the runtime).
    let mode = dialog_opts::pick_mode(save, directory, multiple);
    let picked = off_thread(move || {
        let builder = owner.dialog().file();
        match mode {
            dialog_opts::PickMode::Save => builder
                .blocking_save_file()
                .map(dialog_opts::file_path_to_json),
            // Desktop-only, matching `shell.dialog.pickFile`: the mobile dialog
            // plugin has no folder API, so the request reports "nothing picked".
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
        }
    })
    .await;
    match picked {
        // A cancelled dialog is a legitimate outcome (the user closed it), not
        // a failure: report it as such instead of pretending the link broke.
        Ok(None) => SmokeReport::ok_with(capability, "已取消（未选择）", json!(null)),
        Ok(Some(value)) => SmokeReport::ok_with(capability, "已选择", value),
        Err(err) => SmokeReport::failed(capability, format!("打开选择框失败：{err}")),
    }
}

/// Warning appended to a shortcut registration reply when no host can receive
/// the press (pure, so the wording and the "no host state at all" branch are
/// testable).
///
/// A chord that fires but cannot be delivered looks exactly like a broken
/// callback when pressed; saying it up front is the difference between "the
/// feature is broken" and "the brain is not running".
///
/// Desktop-only: the only caller is the shortcut smoke, which exists only where
/// global shortcuts do.
#[cfg(desktop)]
pub fn host_unavailable_warning(host_available: bool, host: Option<&Value>) -> String {
    if host_available {
        return String::new();
    }
    match host
        .and_then(|view| view.get("phase"))
        .and_then(Value::as_str)
    {
        Some(phase) => format!("；注意：宿主当前不可用（{phase}），按键不会送达 host"),
        None => "；注意：宿主未运行，按键不会送达 host".to_string(),
    }
}

/// Execute one smoke action.
pub async fn run(app: AppHandle, action: SmokeAction) -> SmokeReport {
    let capability = action.capability();
    match action {
        SmokeAction::Notify { title, body } => {
            let (title, body) = notify_defaults(title.as_deref(), body.as_deref());
            match crate::notify::notify_simple(&app, &title, &body) {
                Ok(()) => SmokeReport::ok_with(
                    capability,
                    format!("已请求系统通知：{title}"),
                    json!({ "title": title, "body": body }),
                ),
                Err(err) => SmokeReport::failed(capability, format!("系统通知失败：{err}")),
            }
        }
        SmokeAction::DialogMessage {
            text,
            kind,
            buttons,
        } => dialog_message(app, text, kind, buttons).await,
        SmokeAction::DialogAsk { text, buttons } => dialog_ask(app, text, buttons).await,
        SmokeAction::DialogPickFile {
            save,
            directory,
            multiple,
        } => {
            dialog_pick_file(
                app,
                save.unwrap_or(false),
                directory.unwrap_or(false),
                multiple.unwrap_or(false),
            )
            .await
        }
        #[cfg(desktop)]
        SmokeAction::TrayRender => match crate::tray::refresh(&app) {
            Err(err) => SmokeReport::failed(capability, format!("托盘重渲染失败：{err}")),
            Ok(()) => match crate::tray::smoke_state(&app) {
                Ok(state) => {
                    let groups = state.get("groups").and_then(Value::as_u64).unwrap_or(0);
                    let items = state.get("items").and_then(Value::as_u64).unwrap_or(0);
                    SmokeReport::ok_with(
                        capability,
                        format!("托盘已重渲染：{groups} 个分组 / {items} 个条目（图标与菜单请肉眼确认）"),
                        state,
                    )
                }
                Err(err) => SmokeReport::failed(capability, err),
            },
        },
        #[cfg(desktop)]
        SmokeAction::TrayDispatch { id } => match crate::tray::dispatch_smoke_item(&app, &id) {
            Ok(()) => SmokeReport::ok_with(
                capability,
                format!("已按真实路由派发托盘项 {id}"),
                json!({ "id": id }),
            ),
            Err(err) => SmokeReport::failed(capability, err),
        },
        #[cfg(desktop)]
        SmokeAction::ShortcutRegister { accelerator } => {
            match crate::shortcut::parse_accelerator(&accelerator) {
                Err(err) => {
                    SmokeReport::failed(capability, format!("无法解析 {accelerator}：{err}"))
                }
                Ok(shortcut) => {
                    let registration = crate::shortcut::register_with_os(&app, shortcut);
                    let canonical = crate::shortcut::canonical(shortcut);
                    let registered = crate::shortcut::registered_count(&app);
                    // Say it NOW when nothing is listening: a chord that fires
                    // but cannot be delivered is the one outcome a developer
                    // cannot tell apart from a broken callback by pressing it.
                    let host = crate::shortcut::host_view(&app);
                    let warning = host_unavailable_warning(
                        crate::shortcut::host_available(&app),
                        host.as_ref(),
                    );
                    if registration.ok {
                        SmokeReport::ok_with(
                            capability,
                            format!(
                                "已注册 {canonical}：现在按下这个组合键，回调应被记录（当前已注册 {} 个）{warning}",
                                registered.unwrap_or(0)
                            ),
                            json!({
                                "accelerator": canonical,
                                "registered": registered,
                                "host": host,
                            }),
                        )
                    } else {
                        SmokeReport::failed(
                            capability,
                            format!(
                                "注册 {canonical} 失败：{}",
                                registration.error.unwrap_or_else(|| "未知原因".into())
                            ),
                        )
                    }
                }
            }
        }
        #[cfg(desktop)]
        SmokeAction::ShortcutUnregister { accelerator } => {
            match crate::shortcut::parse_accelerator(&accelerator) {
                Err(err) => {
                    SmokeReport::failed(capability, format!("无法解析 {accelerator}：{err}"))
                }
                Ok(shortcut) => {
                    let registration = crate::shortcut::unregister_with_os(&app, shortcut);
                    let canonical = crate::shortcut::canonical(shortcut);
                    let registered = crate::shortcut::registered_count(&app);
                    if registration.ok {
                        SmokeReport::ok_with(
                            capability,
                            format!(
                                "已反注册 {canonical}（当前已注册 {} 个）",
                                registered.unwrap_or(0)
                            ),
                            json!({ "accelerator": canonical, "registered": registered }),
                        )
                    } else {
                        SmokeReport::failed(
                            capability,
                            format!(
                                "反注册 {canonical} 失败：{}",
                                registration.error.unwrap_or_else(|| "未知原因".into())
                            ),
                        )
                    }
                }
            }
        }
        SmokeAction::SecondInstance => {
            let program = match second_instance_program(std::env::current_exe().ok()) {
                Ok(program) => program,
                Err(err) => return SmokeReport::failed(capability, err),
            };
            match second_instance_command(&program).spawn() {
                Ok(child) => SmokeReport::ok_with(
                    capability,
                    format!(
                        "已启动第二个实例（pid {}）：它应通知本实例聚焦主窗口后自行退出",
                        child.id()
                    ),
                    json!({ "pid": child.id(), "program": program.to_string_lossy() }),
                ),
                Err(err) => SmokeReport::failed(
                    capability,
                    format!("启动第二个实例失败（{}）：{err}", program.display()),
                ),
            }
        }
    }
}

/// Dev smoke command: parse a request, run it, always return a report.
///
/// An unparsable request is reported as a `unknown` capability failure — the
/// panel shows it instead of the call throwing.
#[tauri::command]
pub async fn capability_smoke(app: AppHandle, action: Value) -> SmokeReport {
    match parse_action(&action) {
        Ok(parsed) => run(app, parsed).await,
        Err(err) => SmokeReport::failed("unknown", err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_action_accepts_every_documented_camel_case_shape() {
        assert_eq!(
            parse_action(&json!({ "action": "notify" })).unwrap(),
            SmokeAction::Notify {
                title: None,
                body: None
            }
        );
        assert_eq!(
            parse_action(&json!({ "action": "notify", "title": "t", "body": "b" })).unwrap(),
            SmokeAction::Notify {
                title: Some("t".into()),
                body: Some("b".into())
            }
        );
        assert_eq!(
            parse_action(&json!({ "action": "dialogMessage", "kind": "warning" })).unwrap(),
            SmokeAction::DialogMessage {
                text: None,
                kind: Some("warning".into()),
                buttons: None
            }
        );
        assert_eq!(
            parse_action(&json!({ "action": "dialogAsk", "buttons": "yesNo" })).unwrap(),
            SmokeAction::DialogAsk {
                text: None,
                buttons: Some("yesNo".into())
            }
        );
        assert_eq!(
            parse_action(&json!({ "action": "dialogPickFile", "save": true })).unwrap(),
            SmokeAction::DialogPickFile {
                save: Some(true),
                directory: None,
                multiple: None
            }
        );
        // Desktop-only actions: their variants do not exist on mobile, so the
        // wire round-trip is asserted only where they do.
        #[cfg(desktop)]
        {
            assert_eq!(
                parse_action(&json!({ "action": "trayRender" })).unwrap(),
                SmokeAction::TrayRender
            );
            assert_eq!(
                parse_action(&json!({ "action": "trayDispatch", "id": "core.window.show" }))
                    .unwrap(),
                SmokeAction::TrayDispatch {
                    id: "core.window.show".into()
                }
            );
            assert_eq!(
                parse_action(
                    &json!({ "action": "shortcutRegister", "accelerator": "Ctrl+Shift+K" })
                )
                .unwrap(),
                SmokeAction::ShortcutRegister {
                    accelerator: "Ctrl+Shift+K".into()
                }
            );
            assert_eq!(
                parse_action(
                    &json!({ "action": "shortcutUnregister", "accelerator": "Ctrl+Shift+K" })
                )
                .unwrap(),
                SmokeAction::ShortcutUnregister {
                    accelerator: "Ctrl+Shift+K".into()
                }
            );
        }
        assert_eq!(
            parse_action(&json!({ "action": "secondInstance" })).unwrap(),
            SmokeAction::SecondInstance
        );
    }

    #[test]
    fn parse_action_rejects_unknown_or_misspelled_requests() {
        // The tag is camelCase: a snake_case caller is a bug, not a synonym.
        assert!(parse_action(&json!({ "action": "second_instance" })).is_err());
        assert!(parse_action(&json!({ "action": "notify_all" })).is_err());
        assert!(parse_action(&json!({})).is_err());
        assert!(parse_action(&json!("notify")).is_err());
        // A missing required field must not silently default: dispatching
        // nothing is worse than an error the panel can show.
        // (Desktop-only actions, which are the ones with required fields.)
        #[cfg(desktop)]
        {
            assert!(parse_action(&json!({ "action": "trayDispatch" })).is_err());
            assert!(parse_action(&json!({ "action": "shortcutRegister" })).is_err());
        }
    }

    #[test]
    fn capability_labels_cover_all_five_capabilities() {
        let mut labels = vec![
            SmokeAction::Notify {
                title: None,
                body: None,
            }
            .capability(),
            SmokeAction::DialogMessage {
                text: None,
                kind: None,
                buttons: None,
            }
            .capability(),
            SmokeAction::DialogAsk {
                text: None,
                buttons: None,
            }
            .capability(),
            SmokeAction::DialogPickFile {
                save: None,
                directory: None,
                multiple: None,
            }
            .capability(),
            SmokeAction::SecondInstance.capability(),
        ];
        // Tray and shortcut are desktop-only capabilities, so both the variants
        // and their expected labels are desktop-only.
        #[cfg(desktop)]
        labels.extend([
            SmokeAction::TrayRender.capability(),
            SmokeAction::TrayDispatch { id: "x".into() }.capability(),
            SmokeAction::ShortcutRegister {
                accelerator: "x".into(),
            }
            .capability(),
            SmokeAction::ShortcutUnregister {
                accelerator: "x".into(),
            }
            .capability(),
        ]);

        let mut expected = vec!["notification", "dialog", "single-instance"];
        #[cfg(desktop)]
        expected.extend(["tray", "shortcut"]);

        for capability in expected {
            assert!(labels.contains(&capability), "{capability} is unlabelled");
        }
    }

    #[test]
    fn notify_defaults_fill_in_empty_input_but_respect_real_input() {
        let (title, body) = notify_defaults(None, None);
        assert!(!title.is_empty());
        assert!(!body.is_empty());

        // Whitespace-only is "not provided", not a blank toast.
        let (title, body) = notify_defaults(Some("   "), Some("\t\n"));
        assert!(!title.is_empty());
        assert!(!body.is_empty());

        let (title, body) = notify_defaults(Some("自定义"), Some("正文"));
        assert_eq!(title, "自定义");
        assert_eq!(body, "正文");
    }

    #[test]
    #[cfg(desktop)]
    fn host_warning_says_nothing_when_a_host_can_receive_the_press() {
        assert_eq!(host_unavailable_warning(true, None), "");
        assert_eq!(
            host_unavailable_warning(true, Some(&json!({ "phase": "ready" }))),
            ""
        );
    }

    #[test]
    #[cfg(desktop)]
    fn host_warning_names_the_host_state_when_there_is_one() {
        // The phase travels with the warning so the panel answers "why" too.
        let warning = host_unavailable_warning(
            false,
            Some(&json!({ "phase": "backoff", "pid": null, "lastError": "boom" })),
        );
        assert!(warning.contains("backoff"), "{warning}");
        assert!(warning.contains("不会送达 host"), "{warning}");

        // No host state at all (nothing managed): still a clear warning, never
        // an empty string that would read like success.
        let warning = host_unavailable_warning(false, None);
        assert!(warning.contains("宿主未运行"), "{warning}");
        // A host view without a usable phase must not produce "（null）".
        let warning = host_unavailable_warning(false, Some(&json!({})));
        assert!(!warning.contains("null"), "{warning}");
        assert!(warning.contains("宿主未运行"), "{warning}");
    }

    #[test]
    fn second_instance_launches_this_executable_with_no_arguments() {
        let exe = PathBuf::from("C:\\fake\\vrcx-k.exe");
        let program = second_instance_program(Some(exe.clone())).expect("program resolves");
        assert_eq!(program, exe);

        // The launch is the running binary itself, unchanged: no synthetic
        // flags, because the plugin forwards this argv to the first instance
        // and a real relaunch has none.
        let command = second_instance_command(&program);
        assert_eq!(command.get_program(), program.as_os_str());
        assert_eq!(command.get_args().count(), 0);

        // With no current_exe the smoke reports a reason instead of guessing.
        let err = second_instance_program(None).expect_err("no program");
        assert!(err.contains("current_exe"), "{err}");
    }
}
