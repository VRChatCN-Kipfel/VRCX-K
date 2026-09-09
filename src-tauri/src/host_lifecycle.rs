//! Versioned host lifecycle DTO and deterministic command reducer.
//!
//! This module deliberately contains no Tauri menu types and no process handles.
//! Native tray rendering remains an M1-1 concern. The JSON Schema in
//! `contracts/host-lifecycle/v1` is the cross-language canonical wire contract;
//! this module is the Rust generated/manual mirror validated by contract tests.

use serde::{Deserialize, Serialize};

pub const HOST_LIFECYCLE_SCHEMA_VERSION: u16 = 1;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[allow(dead_code)]
pub const HOST_LIFECYCLE_SCHEMA_ID: &str =
    "https://vrcx-k.dev/contracts/host-lifecycle/v1/host-lifecycle.schema.json";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostLifecycleState {
    #[default]
    Stopped,
    Starting,
    Ready,
    Stopping,
    Backoff,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostDesiredState {
    #[default]
    Running,
    Stopped,
    AppExit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostCommand {
    Start,
    GracefulStop,
    ForceKill,
    Restart,
    Reload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HostExitSummary {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HostSnapshot {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u16,
    pub generation: u64,
    pub phase: HostLifecycleState,
    pub desired: HostDesiredState,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub attempt: u32,
    #[serde(rename = "nextRetryMs")]
    pub next_retry_ms: Option<u64>,
    #[serde(rename = "lastExit")]
    pub last_exit: Option<HostExitSummary>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
}

impl Default for HostSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

impl HostSnapshot {
    pub fn new() -> Self {
        Self {
            schema_version: HOST_LIFECYCLE_SCHEMA_VERSION,
            generation: 0,
            phase: HostLifecycleState::Stopped,
            desired: HostDesiredState::Running,
            pid: None,
            port: None,
            attempt: 0,
            next_retry_ms: None,
            last_exit: None,
            last_error: None,
        }
    }

    #[allow(dead_code)]
    pub fn is_host_ready(&self) -> bool {
        self.phase == HostLifecycleState::Ready
    }

    /// Allocate the public generation exactly once for a real host spawn.
    /// Command cancellation/fencing must use `command_epoch`, not this value.
    #[allow(dead_code)]
    pub fn allocate_generation(&mut self) -> Result<u64, &'static str> {
        if self.generation >= MAX_SAFE_INTEGER {
            return Err("host generation exceeds JSON safe integer range");
        }
        self.generation += 1;
        Ok(self.generation)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum HostCommandResult {
    Accepted {
        generation: u64,
    },
    Noop {
        phase: HostLifecycleState,
    },
    Rejected {
        phase: HostLifecycleState,
        reason: String,
    },
}

impl HostCommandResult {
    pub fn accepted(generation: u64) -> Self {
        Self::Accepted { generation }
    }
}

/// Minimal typed facade consumed by #6. It exposes only DTOs and commands;
/// Child, Peer, process tree, and native tray handles never cross this boundary.
#[allow(dead_code)]
pub trait HostLifecycleFacade: Send + Sync {
    fn snapshot(&self) -> HostSnapshot;
    fn dispatch(&self, command: HostCommand) -> HostCommandResult;
}

/// Internal command epoch used for fencing stale stop/restart callbacks. It is
/// deliberately not serialized and must never be presented as host generation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[allow(dead_code)]
pub struct CommandEpoch(u64);

impl CommandEpoch {
    #[allow(dead_code)]
    pub fn advance(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(1);
        self.0
    }

    #[allow(dead_code)]
    pub fn current(self) -> u64 {
        self.0
    }
}

/// Deterministic command reducer used by the controller worker. Process
/// spawning/RPC calls are outside this pure core. A real spawn owner must call
/// `HostSnapshot::allocate_generation` after it has committed a child.
pub fn reduce_command(snapshot: &mut HostSnapshot, command: HostCommand) -> HostCommandResult {
    use HostCommand::*;
    use HostLifecycleState::{Backoff, Failed, Ready, Starting, Stopped, Stopping};

    let phase = snapshot.phase;
    match command {
        Start => match phase {
            Stopped | Failed | Backoff => {
                snapshot.phase = Starting;
                snapshot.desired = HostDesiredState::Running;
                snapshot.attempt = 0;
                snapshot.next_retry_ms = None;
                snapshot.last_error = None;
                HostCommandResult::accepted(snapshot.generation)
            }
            Starting | Ready => HostCommandResult::Noop { phase },
            Stopping => HostCommandResult::Rejected {
                phase,
                reason: "host is stopping".into(),
            },
        },
        GracefulStop => match phase {
            Starting | Ready | Backoff => {
                snapshot.phase = HostLifecycleState::Stopping;
                snapshot.desired = HostDesiredState::Stopped;
                snapshot.next_retry_ms = None;
                HostCommandResult::accepted(snapshot.generation)
            }
            Stopped => HostCommandResult::Noop { phase },
            Stopping => HostCommandResult::Noop { phase },
            Failed => HostCommandResult::Rejected {
                phase,
                reason: "host is not running".into(),
            },
        },
        ForceKill => match phase {
            Starting | Ready | Stopping => {
                snapshot.phase = HostLifecycleState::Stopping;
                snapshot.desired = HostDesiredState::Stopped;
                HostCommandResult::accepted(snapshot.generation)
            }
            Stopped | Backoff | Failed => HostCommandResult::Noop { phase },
        },
        Restart => match phase {
            Stopped | Failed | Backoff | Ready => {
                snapshot.phase = Starting;
                snapshot.desired = HostDesiredState::Running;
                snapshot.attempt = 0;
                snapshot.next_retry_ms = None;
                snapshot.last_error = None;
                HostCommandResult::accepted(snapshot.generation)
            }
            Starting => HostCommandResult::Noop { phase },
            Stopping => HostCommandResult::Rejected {
                phase,
                reason: "host is stopping".into(),
            },
        },
        Reload => match phase {
            Ready => {
                // Reload is a host-cooperative restart (exit 51), unlike Restart,
                // which the shell must complete even if the host is wedged.
                HostCommandResult::accepted(snapshot.generation)
            }
            _ => HostCommandResult::Rejected {
                phase,
                reason: "host must be ready to reload".into(),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_uses_versioned_camel_case_wire_names_and_excludes_token() {
        let snapshot = HostSnapshot::new();
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["phase"], "stopped");
        assert_eq!(value["desired"], "running");
        assert!(value.get("token").is_none());
        assert!(value.get("schema_version").is_none());
        assert_eq!(
            serde_json::to_string(&HostCommand::GracefulStop).unwrap(),
            "\"graceful_stop\""
        );
    }

    #[test]
    fn generation_is_allocated_only_for_real_spawn_not_commands() {
        let mut snapshot = HostSnapshot::new();
        assert_eq!(
            reduce_command(&mut snapshot, HostCommand::Start),
            HostCommandResult::Accepted { generation: 0 }
        );
        assert_eq!(snapshot.generation, 0);
        assert_eq!(snapshot.allocate_generation(), Ok(1));
        assert_eq!(snapshot.generation, 1);
    }

    #[test]
    fn stop_and_force_kill_do_not_change_generation() {
        let mut snapshot = HostSnapshot::new();
        snapshot.phase = HostLifecycleState::Ready;
        snapshot.generation = 7;
        assert!(matches!(
            reduce_command(&mut snapshot, HostCommand::GracefulStop),
            HostCommandResult::Accepted { generation: 7 }
        ));
        assert_eq!(snapshot.generation, 7);
        assert_eq!(snapshot.desired, HostDesiredState::Stopped);
        assert!(matches!(
            reduce_command(&mut snapshot, HostCommand::ForceKill),
            HostCommandResult::Accepted { generation: 7 }
        ));
    }

    #[test]
    fn command_epoch_fences_without_reusing_process_generation() {
        let mut epoch = CommandEpoch::default();
        assert_eq!(epoch.current(), 0);
        assert_eq!(epoch.advance(), 1);
        assert_eq!(epoch.advance(), 2);
    }

    #[test]
    fn stop_is_terminal_for_supervisor_and_does_not_request_relaunch() {
        let mut snapshot = HostSnapshot::new();
        snapshot.phase = HostLifecycleState::Ready;
        assert!(matches!(
            reduce_command(&mut snapshot, HostCommand::GracefulStop),
            HostCommandResult::Accepted { .. }
        ));
        assert_eq!(snapshot.phase, HostLifecycleState::Stopping);
        assert_eq!(snapshot.desired, HostDesiredState::Stopped);
        assert!(matches!(
            reduce_command(&mut snapshot, HostCommand::Start),
            HostCommandResult::Rejected { .. }
        ));
    }

    #[test]
    fn reload_only_accepts_ready_without_changing_generation() {
        let mut snapshot = HostSnapshot::new();
        assert!(matches!(
            reduce_command(&mut snapshot, HostCommand::Reload),
            HostCommandResult::Rejected { .. }
        ));
        snapshot.phase = HostLifecycleState::Ready;
        assert_eq!(
            reduce_command(&mut snapshot, HostCommand::Reload),
            HostCommandResult::Accepted { generation: 0 }
        );
    }

    #[test]
    fn schema_is_the_versioned_canonical_contract() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../contracts/host-lifecycle/v1/host-lifecycle.schema.json"
        ))
        .unwrap();
        assert_eq!(
            schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
        assert_eq!(schema["$id"], HOST_LIFECYCLE_SCHEMA_ID);
        assert_eq!(schema["properties"]["schemaVersion"]["const"], 1);
        assert_eq!(
            schema["properties"]["generation"]["maximum"],
            MAX_SAFE_INTEGER
        );
    }

    #[test]
    fn generation_overflow_is_rejected_before_wire_loss() {
        let mut snapshot = HostSnapshot::new();
        snapshot.generation = MAX_SAFE_INTEGER;
        assert_eq!(
            snapshot.allocate_generation(),
            Err("host generation exceeds JSON safe integer range")
        );
    }
}
