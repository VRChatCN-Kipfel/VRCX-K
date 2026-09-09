//! Rust-owned application lifecycle facade for `target=app` tray actions.
//! Host never receives or executes these commands; the shell coordinates the
//! HostLifecycleFacade and Tauri process lifecycle.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU8, Ordering};

pub const APP_LIFECYCLE_SCHEMA_VERSION: u16 = 1;
#[allow(dead_code)]
pub const APP_LIFECYCLE_SCHEMA_ID: &str =
    "https://vrcx-k.dev/contracts/app-lifecycle/v1/app-lifecycle.schema.json";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppCommand {
    RestartGraceful,
    QuitGraceful,
    QuitForce,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AppCommandRequest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u16,
    pub command: AppCommand,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AppCommandResult {
    Accepted { command: AppCommand },
    Noop { command: AppCommand },
    Rejected { command: AppCommand, reason: String },
}

pub trait AppLifecycleFacade: Send + Sync {
    fn dispatch(&self, request: AppCommandRequest) -> AppCommandResult;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum AppIntent {
    Running = 0,
    Restarting = 1,
    Quitting = 2,
    ForceQuitting = 3,
}

pub struct AppLifecycle {
    intent: AtomicU8,
}

impl Default for AppLifecycle {
    fn default() -> Self {
        Self {
            intent: AtomicU8::new(AppIntent::Running as u8),
        }
    }
}

impl AppLifecycleFacade for AppLifecycle {
    fn dispatch(&self, request: AppCommandRequest) -> AppCommandResult {
        if request.schema_version != APP_LIFECYCLE_SCHEMA_VERSION {
            return AppCommandResult::Rejected {
                command: request.command,
                reason: "unsupported app lifecycle schema version".into(),
            };
        }
        self.begin(request.command)
    }
}

impl AppLifecycle {
    pub fn begin(&self, command: AppCommand) -> AppCommandResult {
        let next = match command {
            AppCommand::RestartGraceful => AppIntent::Restarting,
            AppCommand::QuitGraceful => AppIntent::Quitting,
            AppCommand::QuitForce => AppIntent::ForceQuitting,
        };
        loop {
            let current = self.intent.load(Ordering::Acquire);
            if current == next as u8 {
                return AppCommandResult::Noop { command };
            }
            // Force quit is an emergency escape hatch and may always escalate a
            // graceful restart/quit. The in-flight graceful worker is fenced by
            // HostState's AppExit latch/process-tree take and becomes harmless.
            let may_transition = current == AppIntent::Running as u8
                || (next == AppIntent::ForceQuitting && current != AppIntent::ForceQuitting as u8);
            if !may_transition {
                return AppCommandResult::Rejected {
                    command,
                    reason: "another application lifecycle command is in progress".into(),
                };
            }
            match self.intent.compare_exchange(
                current,
                next as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return AppCommandResult::Accepted { command },
                Err(_) => continue,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_command_uses_versioned_camel_case_payload() {
        let payload = AppCommandRequest {
            schema_version: APP_LIFECYCLE_SCHEMA_VERSION,
            command: AppCommand::RestartGraceful,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["command"], "restart_graceful");
        assert!(value.get("schema_version").is_none());
    }

    #[test]
    fn app_schema_is_canonical_draft_2020_12_v1() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../contracts/app-lifecycle/v1/app-lifecycle.schema.json"
        ))
        .unwrap();
        assert_eq!(
            schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
        assert_eq!(schema["$id"], APP_LIFECYCLE_SCHEMA_ID);
    }

    #[test]
    fn command_latch_is_idempotent_and_rejects_conflicts() {
        let lifecycle = AppLifecycle::default();
        assert_eq!(
            lifecycle.begin(AppCommand::QuitGraceful),
            AppCommandResult::Accepted {
                command: AppCommand::QuitGraceful
            }
        );
        assert_eq!(
            lifecycle.begin(AppCommand::QuitGraceful),
            AppCommandResult::Noop {
                command: AppCommand::QuitGraceful
            }
        );
        assert!(matches!(
            lifecycle.begin(AppCommand::RestartGraceful),
            AppCommandResult::Rejected { .. }
        ));
    }

    #[test]
    fn force_quit_escalates_graceful_intent() {
        let lifecycle = AppLifecycle::default();
        assert!(matches!(
            lifecycle.begin(AppCommand::QuitGraceful),
            AppCommandResult::Accepted { .. }
        ));
        assert!(matches!(
            lifecycle.begin(AppCommand::QuitForce),
            AppCommandResult::Accepted {
                command: AppCommand::QuitForce
            }
        ));
        assert!(matches!(
            lifecycle.begin(AppCommand::QuitForce),
            AppCommandResult::Noop {
                command: AppCommand::QuitForce
            }
        ));
    }
}
