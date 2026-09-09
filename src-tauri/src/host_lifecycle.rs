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

/// Coarse identity of the parts of a snapshot that shell surfaces depend on.
///
/// Used by the supervisor's change feed so a snapshot that is unchanged does
/// not trigger a tray rebuild or a `host-lifecycle` event. `next_retry_ms` is
/// deliberately excluded: it ticks every 50ms while backing off and would turn
/// the feed into a poll. The payload still carries the current value.
pub fn snapshot_fingerprint(snapshot: &HostSnapshot) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    mix(&snapshot.schema_version.to_le_bytes());
    mix(&snapshot.generation.to_le_bytes());
    mix(&snapshot.attempt.to_le_bytes());
    mix(&snapshot.pid.unwrap_or(u32::MAX).to_le_bytes());
    mix(&snapshot.port.unwrap_or(u16::MAX).to_le_bytes());
    mix(format!(
        "{:?}|{:?}|{:?}|{:?}",
        snapshot.phase, snapshot.desired, snapshot.last_exit, snapshot.last_error
    )
    .as_bytes());
    hash
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

    /// Every (command, phase) verdict of the reducer, derived directly from
    /// the match arms in `reduce_command`. Guards against accidental future
    /// drift in any cell of the state machine.
    #[test]
    fn reducer_full_command_phase_matrix() {
        use HostCommand::{ForceKill, GracefulStop, Reload, Restart, Start};
        use HostLifecycleState::*;

        // (command, phase, expected verdict kind, phase after, desired after)
        // Desired states are written fully qualified: `Stopped`/`Running` are
        // also lifecycle phase names, so bare names would be ambiguous.
        use HostDesiredState::{Running, Stopped as DesiredStopped};
        #[allow(clippy::type_complexity)]
        let cases: Vec<(
            HostCommand,
            HostLifecycleState,
            &str,
            HostLifecycleState,
            HostDesiredState,
        )> = vec![
            // Start
            (Start, Stopped, "accepted", Starting, Running),
            (Start, Starting, "noop", Starting, Running),
            (Start, Ready, "noop", Ready, Running),
            (Start, Stopping, "rejected", Stopping, Running),
            (Start, Backoff, "accepted", Starting, Running),
            (Start, Failed, "accepted", Starting, Running),
            // GracefulStop
            (GracefulStop, Stopped, "noop", Stopped, Running),
            (GracefulStop, Starting, "accepted", Stopping, DesiredStopped),
            (GracefulStop, Ready, "accepted", Stopping, DesiredStopped),
            (GracefulStop, Stopping, "noop", Stopping, Running),
            (GracefulStop, Backoff, "accepted", Stopping, DesiredStopped),
            (GracefulStop, Failed, "rejected", Failed, Running),
            // ForceKill
            (ForceKill, Stopped, "noop", Stopped, Running),
            (ForceKill, Starting, "accepted", Stopping, DesiredStopped),
            (ForceKill, Ready, "accepted", Stopping, DesiredStopped),
            (ForceKill, Stopping, "accepted", Stopping, DesiredStopped),
            (ForceKill, Backoff, "noop", Backoff, Running),
            (ForceKill, Failed, "noop", Failed, Running),
            // Restart
            (Restart, Stopped, "accepted", Starting, Running),
            (Restart, Starting, "noop", Starting, Running),
            (Restart, Ready, "accepted", Starting, Running),
            (Restart, Stopping, "rejected", Stopping, Running),
            (Restart, Backoff, "accepted", Starting, Running),
            (Restart, Failed, "accepted", Starting, Running),
            // Reload
            (Reload, Stopped, "rejected", Stopped, Running),
            (Reload, Starting, "rejected", Starting, Running),
            (Reload, Ready, "accepted", Ready, Running),
            (Reload, Stopping, "rejected", Stopping, Running),
            (Reload, Backoff, "rejected", Backoff, Running),
            (Reload, Failed, "rejected", Failed, Running),
        ];

        for (command, phase, kind, phase_after, desired_after) in cases {
            let mut snapshot = HostSnapshot::new();
            snapshot.phase = phase;
            snapshot.desired = Running;
            let result = reduce_command(&mut snapshot, command);
            let actual_kind = match &result {
                HostCommandResult::Accepted { .. } => "accepted",
                HostCommandResult::Noop { .. } => "noop",
                HostCommandResult::Rejected { .. } => "rejected",
            };
            assert_eq!(
                actual_kind, kind,
                "verdict mismatch for {command:?} from {phase:?}"
            );
            // A Noop/Rejected verdict must not mutate the snapshot's phase;
            // Accepted cells set their documented phase/desired.
            assert_eq!(
                snapshot.phase, phase_after,
                "phase after {command:?} from {phase:?} differs"
            );
            assert_eq!(
                snapshot.desired, desired_after,
                "desired after {command:?} from {phase:?} differs"
            );
            // generation must never be advanced by the reducer itself.
            assert_eq!(snapshot.generation, 0, "reducer must not bump generation");
        }
    }
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;

    #[test]
    fn fingerprint_ignores_next_retry_ms_but_tracks_observable_fields() {
        let base = HostSnapshot::new();
        let baseline = snapshot_fingerprint(&base);

        // nextRetryMs ticks every 50ms while backing off: it must not be part
        // of the change feed, or the tray/event feed becomes a poll.
        let mut ticking = base.clone();
        ticking.next_retry_ms = Some(1_234);
        assert_eq!(snapshot_fingerprint(&ticking), baseline);

        // Everything the shell surfaces must change the fingerprint.
        let mut phase = base.clone();
        phase.phase = HostLifecycleState::Ready;
        assert_ne!(snapshot_fingerprint(&phase), baseline);

        let mut desired = base.clone();
        desired.desired = HostDesiredState::AppExit;
        assert_ne!(snapshot_fingerprint(&desired), baseline);

        let mut pid = base.clone();
        pid.pid = Some(42);
        assert_ne!(snapshot_fingerprint(&pid), baseline);

        let mut port = base.clone();
        port.port = Some(43120);
        assert_ne!(snapshot_fingerprint(&port), baseline);

        let mut attempt = base.clone();
        attempt.attempt = 3;
        assert_ne!(snapshot_fingerprint(&attempt), baseline);

        let mut error = base.clone();
        error.last_error = Some("boom".into());
        assert_ne!(snapshot_fingerprint(&error), baseline);

        let mut generation = base.clone();
        generation.generation = 9;
        assert_ne!(snapshot_fingerprint(&generation), baseline);
    }
}
