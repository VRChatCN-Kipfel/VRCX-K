// TrayService unit tests (host → shell tray ingress): contract validation,
// revision bumping, fingerprint diffing, coalescing, push serialization,
// no-shell behaviour and action fan-out. No real shell is involved.
import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { TrayService, fingerprintGroups, type TrayPush, type TrayServiceOptions, type TrayVerdict } from "../src/tray"
import type { TrayGroup, TrayMenuSnapshot } from "../src/tray-contract.generated"
import type { TraySetSnapshotResult } from "../src/stdio"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// TrayService is a cordis `Service` (M2-1 attribution), so it needs a Context
// to register on. Each service gets its own root Context — a shared one would
// reject the second "tray" registration.
const makeTray = (options?: TrayServiceOptions) => new TrayService(new Context(), options)

function action(id: string) {
  return {
    kind: "action" as const,
    id,
    order: 0,
    label: id,
    enabled: true,
    visible: true,
    action: { target: "host" as const, command: "host.ping", args: [], danger: "safe" as const, confirm: false },
  }
}

function group(id: string, itemId = `${id}.item`): TrayGroup {
  return { id, order: 0, label: null, visible: true, source: "host", items: [action(itemId)] }
}

function recordingPush() {
  const snapshots: TrayMenuSnapshot[] = []
  const push: TrayPush = async (snapshot) => {
    snapshots.push(snapshot)
    return { ok: true, revision: snapshot.revision }
  }
  return { push, snapshots }
}

describe("TrayService publication", () => {
  test("pushes a new snapshot once and reports the bumped revision", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray({ push })
    const verdict = await service.setGroups([group("host.a")])
    expect(verdict).toEqual({ status: "pushed", revision: 1, changed: true })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].revision).toBe(1)
    expect(snapshots[0].schemaVersion).toBe(1)
    expect(snapshots[0].groups[0].id).toBe("host.a")
    expect(service.revision).toBe(1)
    expect(service.inSync).toBe(true)
  })

  test("never pushes an identical snapshot (fingerprint diffing)", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray({ push })
    expect(await service.setGroups([group("host.a")])).toEqual({ status: "pushed", revision: 1, changed: true })
    const verdict = await service.setGroups([group("host.a")])
    expect(verdict).toEqual({ status: "unchanged", revision: 1, changed: false })
    expect(snapshots).toHaveLength(1) // zero extra pushes
    expect(service.revision).toBe(1) // and no revision bump
  })

  test("a changed snapshot produces exactly one more push", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray({ push })
    await service.setGroups([group("host.a")])
    const verdict = await service.setGroups([group("host.a"), group("host.b")])
    expect(verdict).toEqual({ status: "pushed", revision: 2, changed: true })
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1].groups).toHaveLength(2)
  })

  test("fingerprint ignores key order", () => {
    const a = group("host.a")
    const reordered = { items: a.items, source: a.source, visible: a.visible, label: a.label, order: a.order, id: a.id } as TrayGroup
    expect(fingerprintGroups([reordered])).toBe(fingerprintGroups([a]))
  })

  test("coalesces rapid updates into a single push of the latest content", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray({ push })
    const first = service.setGroups([group("host.a")])
    const second = service.setGroups([group("host.b")])
    expect(await first).toEqual({ status: "coalesced", revision: 1 })
    expect(await second).toEqual({ status: "pushed", revision: 2, changed: true })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].groups.map((item) => item.id)).toEqual(["host.b"])
    expect(snapshots[0].revision).toBe(2)
  })

  test("serializes pushes so a slow shell cannot reorder revisions", async () => {
    const pending: Array<{ revision: number; release: () => void }> = []
    const push: TrayPush = (snapshot) =>
      new Promise<TraySetSnapshotResult>((resolve) => {
        pending.push({ revision: snapshot.revision, release: () => resolve({ ok: true, revision: snapshot.revision }) })
      })
    const service = makeTray({ push })
    const first = service.setGroups([group("host.a")])
    await tick()
    expect(pending.map((item) => item.revision)).toEqual([1])

    const second = service.setGroups([group("host.b")])
    await tick()
    // Still one in-flight push: the second waits for the first to settle.
    expect(pending.map((item) => item.revision)).toEqual([1])

    pending[0].release()
    await tick()
    expect(pending.map((item) => item.revision)).toEqual([1, 2])

    pending[1].release()
    expect(await first).toEqual({ status: "pushed", revision: 1, changed: true })
    expect(await second).toEqual({ status: "pushed", revision: 2, changed: true })
  })

  test("reports a push failure and allows an identical retry", async () => {
    let fail = true
    const snapshots: TrayMenuSnapshot[] = []
    const push: TrayPush = async (snapshot) => {
      snapshots.push(snapshot)
      return fail ? { ok: false, revision: snapshot.revision, error: "no tray" } : { ok: true, revision: snapshot.revision }
    }
    const service = makeTray({ push })
    const failed = await service.setGroups([group("host.a")])
    expect(failed).toEqual({ status: "error", revision: 1, error: "no tray" })
    expect(service.inSync).toBe(false)

    fail = false
    const retried = await service.setGroups([group("host.a")])
    expect(retried.status).toBe("pushed")
    expect(snapshots).toHaveLength(2) // same content was pushed again after the failure
  })

  test("a throwing push is reported, not propagated", async () => {
    const service = makeTray({
      push: async () => {
        throw new Error("pipe gone")
      },
    })
    expect(await service.setGroups([group("host.a")])).toEqual({ status: "error", revision: 1, error: "pipe gone" })
  })
})

describe("TrayService without a shell", () => {
  test("returns a no-shell verdict and stays functional", async () => {
    const service = makeTray()
    const verdict = await service.setGroups([group("host.a")])
    expect(verdict).toEqual({ status: "no-shell", revision: 1 })
    expect(service.attached).toBe(false)
    expect(await service.setGroups([group("host.a")])).toEqual({ status: "unchanged", revision: 1, changed: false })
  })

  test("resyncs the pending content when a shell attaches", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray()
    await service.setGroups([group("host.a")]) // requested during bootstrap
    expect(snapshots).toHaveLength(0)

    service.attachShell(push)
    await tick()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].groups[0].id).toBe("host.a")
    expect(service.inSync).toBe(true)
  })
})

describe("TrayService validation", () => {
  test("rejects core-owned groups (host may only push host/plugin groups)", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray({ push })
    const core = { id: "core.x", order: 0, label: null, visible: true, source: "core", items: [] } as unknown as TrayGroup
    const verdict: TrayVerdict = await service.setGroups([core])
    expect(verdict.status).toBe("invalid")
    expect(String((verdict as { error: string }).error)).toMatch(/source core/)
    expect(snapshots).toHaveLength(0)
    expect(service.revision).toBe(0)
  })

  test("rejects a malformed group via the contract schema", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray({ push })
    const bad = { ...group("host.a"), items: [{ kind: "action", id: "x" }] } as unknown as TrayGroup
    const verdict = await service.setGroups([bad])
    expect(verdict.status).toBe("invalid")
    expect(snapshots).toHaveLength(0)
  })
})

describe("TrayService actions", () => {
  test("fans tray.action out to every handler and unsubscribes", () => {
    const service = makeTray()
    const first: string[] = []
    const second: string[] = []
    const offFirst = service.onAction((action) => first.push(action.id))
    service.onAction((action) => second.push(action.id))

    expect(service.dispatchAction({ id: "host.a", command: "host.ping", args: [1] })).toBe(true)
    expect(first).toEqual(["host.a"])
    expect(second).toEqual(["host.a"])

    offFirst()
    service.dispatchAction({ id: "host.b", command: "host.ping", args: [] })
    expect(first).toEqual(["host.a"])
    expect(second).toEqual(["host.a", "host.b"])
  })

  test("a throwing handler does not stop the fan-out", () => {
    const service = makeTray()
    const seen: string[] = []
    service.onAction(() => {
      throw new Error("handler exploded")
    })
    service.onAction((action) => seen.push(action.id))
    expect(service.dispatchAction({ id: "host.a", command: "host.ping", args: [] })).toBe(true)
    expect(seen).toEqual(["host.a"])
  })

  test("ignores a malformed tray.action payload", () => {
    const service = makeTray()
    const seen: unknown[] = []
    service.onAction((action) => seen.push(action))
    expect(service.dispatchAction(null)).toBe(false)
    expect(service.dispatchAction({ command: "host.ping" })).toBe(false)
    expect(service.dispatchAction({ id: "host.a", command: 42 })).toBe(false)
    expect(service.dispatchAction({ id: "host.a", command: "host.ping", args: "nope" })).toBe(false)
    expect(seen).toHaveLength(0)
  })

  test("close() resolves a queued update as closed and refuses further ones", async () => {
    const { push, snapshots } = recordingPush()
    const service = makeTray({ push })
    const first = service.setGroups([group("host.a")])
    const second = service.setGroups([group("host.b")]) // still queued (flush is a microtask)
    service.close()
    expect(await first).toEqual({ status: "coalesced", revision: 1 })
    expect(await second).toEqual({ status: "closed", revision: 2 })
    expect(await service.setGroups([group("host.c")])).toEqual({ status: "closed", revision: 2 })
    expect(snapshots).toHaveLength(0)
  })
})
