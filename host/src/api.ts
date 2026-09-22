export const HOST_VERSION = "0.0.1"
export const HOST_RESTART_EXIT = 51

/**
 * The host tore down cooperatively because the shell became unreachable while
 * the startup handshake was still in flight.
 *
 * Why a dedicated code instead of 0 or 1 — both are actively wrong here:
 *
 *   - NOT 0: the handshake never completed, so the shell never learned our ws
 *     port and the app did not start. Exiting 0 would report a clean stop for a
 *     startup that failed. (`stopOnStdinLoss` uses 0 legitimately, because by
 *     then the shell and host have already agreed on a session.)
 *   - NOT 1: the shell's `classify_watch` treats every code except 51 as
 *     `Crashed` and feeds it to the restart-storm counter. Eight of those inside
 *     the stable window park the host in `Failed` permanently — punishing it for
 *     a failure that was never its own. `docs/shutdown-strategy-review.md` §5.4
 *     already ruled that `exit(1)` must be avoided for exactly this reason; this
 *     constant is that ruling's missing implementation.
 *
 * The shell maps it to a distinct, non-crash outcome and relaunches without
 * counting it against the storm budget. Must stay in step with
 * `HOST_STDIO_LOST_EXIT` in `src-tauri/src/host.rs`, which asserts the value.
 */
export const HOST_STDIO_LOST_EXIT = 52

export type HostWsAPI = {
  ping(): Promise<string>
  getVersion(): Promise<string>
}

export const hostWsAPI: HostWsAPI = {
  async ping() {
    return "pong"
  },
  async getVersion() {
    return HOST_VERSION
  },
}
