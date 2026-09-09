// Host wiring units that must not silently drift with a dependency upgrade:
//
//   1. the cordis fiber-state numbers `index.ts` hard-codes for the readiness
//      check (cordis exports `FiberState` as a `declare const enum`, which has
//      no runtime value and therefore cannot be imported);
//   2. the exact-match rule that decides whether `cordis.yml` declares the
//      heartbeat entry (a loose match used to make unrelated plugins break
//      host startup).
import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import type { Entry } from "@cordisjs/plugin-loader"
import { FIBER_ACTIVE, FIBER_FAILED, declaresHeartbeat } from "../src/fiber"

describe("cordis fiber states used by the readiness check", () => {
  test("ACTIVE is observed on a live plugin fiber", async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(() => {})
    await fiber.await()
    expect(fiber.state).toBe(FIBER_ACTIVE)
  })

  test("FAILED is observed on a throwing plugin fiber", async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(() => {
      throw new Error("boom")
    })
    await fiber.await().catch(() => {})
    expect(fiber.state).toBe(FIBER_FAILED)
  })
})

describe("declaresHeartbeat", () => {
  function includeWith(entries: Array<{ id?: string; name?: string }>): Entry {
    return {
      subtree: {
        entries: () =>
          entries.map((options) => ({ options })),
      },
    } as unknown as Entry
  }

  test("matches the canonical heartbeat entry and plugin file", () => {
    expect(declaresHeartbeat(includeWith([{ id: "heartbeat" }]))).toBe(true)
    expect(declaresHeartbeat(includeWith([{ name: "./plugins/heartbeat.ts" }]))).toBe(true)
    expect(declaresHeartbeat(includeWith([{ name: "plugins\\heartbeat.js" }]))).toBe(true)
    expect(declaresHeartbeat(includeWith([{ id: "heartbeat", name: "./plugins/heartbeat.ts" }]))).toBe(
      true,
    )
  })

  test("does not match unrelated plugins that merely contain the word", () => {
    // A false positive here makes startup wait for a service the plugin never
    // provides and then fail with "heartbeat plugin failed to assemble".
    expect(declaresHeartbeat(includeWith([{ id: "my-heartbeat-monitor" }]))).toBe(false)
    expect(declaresHeartbeat(includeWith([{ name: "./plugins/heartbeat-monitor.ts" }]))).toBe(false)
    expect(declaresHeartbeat(includeWith([{ name: "./plugins/heartbeat2.ts" }]))).toBe(false)
    expect(declaresHeartbeat(includeWith([{ id: "heart" }]))).toBe(false)
  })

  test("no subtree or no entries means no heartbeat", () => {
    expect(declaresHeartbeat({} as unknown as Entry)).toBe(false)
    expect(declaresHeartbeat(includeWith([]))).toBe(false)
  })
})
