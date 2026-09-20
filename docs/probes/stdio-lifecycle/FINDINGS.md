# stdio lifecycle — why `platform.onClose` never fired, measured

> **Scope**: one narrow question, measured. bun **1.4.2**, Windows x64 (`win32`), kkrpc **2.1.0**.
> **Date**: 2026-09-18 · measured on branch `fix/stdio-lifecycle-onclose`.
> **Why this is in the repo**: `host/src/stdio.ts` now cites these findings in its
> rationale comments, so this cannot live only in `.temp/` (see AGENTS.md
> §临时工作区 → 转正触发点). The full probe set (23 probes, 15 raw outputs) was
> produced under `.temp/recon-stdio/probes-h6/`; the probes that carry the
> argument are copied alongside this file.
>
> **Outcome**: this measurement is what justified replacing the hand-rolled
> adapter with `nodeStdioTransport()`. See `host/src/stdio.ts` —
> `bunStdioTransport()`'s doc comment records the two defects and why the stop
> and observe hooks are split.
>
> **Resolution (2026-09-20, PR #38)**: §7's recommendation is the one this
> measurement alone supported, and it has been **superseded** — PR #38 made the
> switch as the deliberate, tested refactor §7's own last clause allows. The
> decision record and the three reasons the blocker did not apply are in §7;
> §5.6's open question now carries a pointer to it. The measurements in §1–§6
> are otherwise unchanged.

---

## 0. Bottom line first

**The question as originally posed was malformed, and its central claim was false.** Corrected answers:

| Question | Answer | Confidence |
|---|---|---|
| Old production shape (`stdio.ts` pre-fix): does `platform.onClose` fire on clean close? | **No** | **Definite** (N≥3, two methods agree) |
| Same, on abrupt close? | **No** | **Definite** |
| The `nodeStdioTransport()` shape *exactly as written in the original task statement* (`stdioPlatform({readable: process.stdin, writable: process.stdout, lifecycle: process.stdin})`, nothing else): does onClose fire? | **No** — also fails, clean and abrupt | **Definite** (5/5 runs) |
| `nodeStdioTransport()` **inside the real `RPCChannel`** (i.e. how it is actually used): does onClose fire? | **Yes**, both clean and abrupt, `reason === undefined` | **Definite** (3/3 runs) |
| Did abrupt (RST) differ from clean (FIN)? | **No, in any shape.** On Windows both are indistinguishable at the reader | **Definite** |
| Was the `#33` orphan-host fix regressed by the old shape? | **No.** The pump's `onDone` fired in every production run | **Definite** |

**Neither candidate explanation offered at the time was correct**, and the earlier recon report's headline claim ("the official shape fires onClose, the hand-rolled one does not, because `getReader()` locks the stream and suppresses `process.stdin`'s end/close events") was an **artifact of inconsistent probe construction**. See §2.

---

## 1. The mechanism (what is actually going on)

### 1.1 Object model — measured, two independent methods

`00-identity.ts` (typeof/`in` introspection) and `01-lock-semantics.ts` (attempt-the-operation) agree:

```
process.stdin          → ctor "ReadStream",  NOT a ReadableStream, has .on/.resume/.pause/.read
Bun.stdin.stream()     → ctor "ReadableStream", has .getReader/.locked
process.stdin === Bun.stdin  → false
Bun.stdin.stream() calls     → return the SAME object each call
```

So `process.stdin` and `Bun.stdin.stream()` are **different objects**. But they are **coupled at the native layer**: bun implements `process.stdin` as a Node-style `ReadStream` shim (`internal:streams/readable`) whose lazily-invoked `_read` calls an internal `own()` that does `Bun.stdin.stream().getReader()` on the *same* native readable. Consequences, all measured:

- `process.stdin.resume()` **throws** `TypeError: Invalid state: ReadableStream is locked` (`ERR_INVALID_STATE`) while a `Bun.stdin.stream()` reader is held.
- Attaching `process.stdin.on("data")` in that state **throws the same error, uncaught, killing the process**.
- Conversely, once `process.stdin` owns the reader, a later `Bun.stdin.stream().getReader()` throws.

The coupling is real; the *object identity* claimed in the prior report ("`process.stdin` and `Bun.stdin.stream()` are the SAME ReadableStream", `docs/probes/probe9.ts:13`) is **wrong**, even though probe9's operational conclusion happened to be right.

### 1.2 The real variable is **flowing mode** — and `lifecycle` can never supply it

Measured per-listener, one process per listener, nothing else attached (`07-listen-triggers-resume.ts`):

| listener attached to `process.stdin` | `readableFlowing` after attach |
|---|---|
| *(none)* | `null` |
| `on("end")` | `null` |
| `on("close")` | `null` |
| `on("error")` | `null` |
| `on("readable")` | `false` |
| **`on("data")`** | **`true`** |

kkrpc's `stdioPlatform` wires `lifecycle` with exactly `on("error")`, `on("end")`, `on("close")` (`kkrpc-src/stdio.ts:107-109`) — **the three listeners that provably do not unpause the stream.** Under bun a paused `ReadStream` never emits `end`/`close`, so `notifyClose()` is never reached and `platform.onClose` never fires.

**This is the whole answer to why the literal official shape fails.** It is not the lock.

### 1.3 What actually rescues it: `subscribe()`

kkrpc's `subscribe()` is implemented as `readable.on("data", onData)` (`kkrpc-src/stdio.ts:147`). In the official shape `readable === process.stdin`, so **subscribing is what flips stdin into flowing mode**. And `RPCChannel`'s constructor subscribes internally — which is why the official shape works in practice but not in isolation.

### 1.4 The lock is a *second, independent* defect — and it is fatal to onClose

In the production shape, `ReadableStreamLike`'s pump holds the native reader forever (it only `releaseLock()`s after the loop ends). This does not merely "suppress" events — it makes every rescue path **throw**:

```
production shape + process.stdin.resume()  →  TypeError: Invalid state: ReadableStream is locked
```

So even if you wired `lifecycle` differently, the production shape cannot be fixed by touching `process.stdin`; the pump owns the stream.

### 1.5 The discriminating measurement (isolating lock from flow mode)

`04-hypothesis-test.ts` uses a **`StubReadable`** that never calls `getReader()` and never touches the native stream — so **no lock exists at all** in those two cells:

| cell | lock present? | flowing? | `onClose` fired? |
|---|---|---|---|
| `stub-paused` | **no** | no (`null`) | **NO** |
| `stub-resume` | **no** | yes (`true`) | **YES** |
| `official-resume` | no | yes | **YES** |
| `production-resume` | **yes** | *(resume threw)* | **NO** |

`stub-paused` vs `stub-resume` differ **only** in flow mode, with the native stream completely uninvolved. That is the case where **only the paused/flowing explanation predicts the result** — exactly the discriminating measurement you asked for. Conversely `production-resume` shows a lock defeating an explicit `resume()`.

**Verdict: the correct explanation is "paused / never-flowing mode" for the official shape, and "the pump's lock" as an additional independent defect in the production shape. Your framing's binary ("which one is right") is the malformed part — for the production shape both are true and they compound; for the official shape only flow mode applies.**

### 1.6 Single-variable confirmation

`09-subscribe-is-the-resumer.ts` — one variable (`transport.subscribe()`), nothing else:

| shape | subscribe | `onClose` fired | `readableFlowing` |
|---|---|---|---|
| official | 0 | **false** | `null` |
| official | 1 | **true** | `true` |
| production | 0 | false | `null` |
| production | 1 | **false** (no help) | `null` |

Production + subscribe does *not* help, because kkrpc attaches `data` to the `ReadableStreamLike` **stub**, never to `process.stdin`. This asymmetry is the whole difference between the two shapes.

---

## 2. Why the prior probes contradicted each other (all three traps reproduced)

Your four iterations disagreed because **each probe accidentally varied flowing mode**, not because the underlying behaviour is unstable.

| Probe | Construction | stdin flowing? | Reading | Correct interpretation |
|---|---|---|---|---|
| probe-g | child attached its own `process.stdin` listeners | **yes** | "official works" ✅ | true, but due to *its own listeners*, not the official shape |
| probe-h4 | no extra listeners, official shape | no | "nothing fires" | **true for the shape as written** |
| probe-h5 `official-clean` | empty stdout, process died | — | `parseError, raw:""` | **explained below** |
| h6 `05` clean room | `attach=0,resume=0` | no | official → no fire | **correct baseline** |
| h6 `06` independent | added `transport.subscribe()` | **yes** | official → fires | true, but *subscribe* caused it |

**probe-h5's silent `official` death is now fully explained.** It is not an unhandled rejection and not `process.stdin` being used for both roles. It is:

```
RPCChannel constructor
  → transport.subscribe()
    → readable.on("data")           // readable === process.stdin in the official shape
      → bun's internal own()
        → Bun.stdin.stream().getReader()   // already held → THROWS
TypeError: Invalid state: ReadableStream is locked   (ERR_INVALID_STATE, uncaught)
```

Reproduced verbatim as exit code 1 with **empty stdout** (`02-coupling-matrix.ts`, modes `str-then-stdin`):

```
TypeError: Invalid state: ReadableStream is locked
 code: "ERR_INVALID_STATE"
      at own (5:15)
      at attachStdinEvents (.../02-coupling-matrix.ts:52:9)
```

In probe-h5 the throw happened at *top level* during setup, before any output was flushed — hence `raw:""`. Note this is only reachable when the pump/reader is taken **first**; the `production` shape is immune because kkrpc attaches `data` to the stub.

**Also note `01-lock-semantics.ts` is itself a negative example** and is kept as such: it died with the identical uncaught throw at its line 89 (`stdin.resume()`), which is how this mechanism was first spotted.

---

## 3. Results table (raw numbers)

### 3.1 Consolidated final matrix — `13-final-matrix.ts`, real kkrpc, real pipe on fd0, teardown at 900 ms, 5000 ms window

Every row asserts `shapeHonored=true` (guards against the env-override bug described in §6). `fd0 = fifo=true socket=false chr=false` in **all** rows.

| # | shape | teardown | `hasOnClose` | `onCloseFired` | `onCloseReason` | pump `onDone` | `readableFlowing` | exit |
|---|---|---|---|---|---|---|---|---|
| 1 | `production` | clean | true | **false** | `null` | **true** | `null` | 0 |
| 2 | `production` | abrupt | true | **false** | `null` | **true** | `null` | 0 |
| 3 | `official-raw` | clean | true | **false** | `null` | — | `null` | 0 |
| 4 | `official-raw` | abrupt | true | **false** | `null` | — | `null` | 0 |
| 5 | `official-real` (`nodeStdioTransport()`) | clean | true | **false** | `null` | — | `null` | 0 |
| 6 | `official-real` | abrupt | true | **false** | `null` | — | `null` | 0 |
| 7 | `production` + real `RPCChannel` | clean | true | **false** | `null` | **true** | `null` | 0 |
| 8 | `production` + real `RPCChannel` | abrupt | true | **false** | `null` | **true** | `null` | 0 |
| 9 | **`nodeStdioTransport()` + real `RPCChannel`** | clean | true | **TRUE** | `clean(undefined)` | false | **true** | 0 |
| 10 | **`nodeStdioTransport()` + real `RPCChannel`** | abrupt | true | **TRUE** | `clean(undefined)` | false | **true** | 0 |

Rows 3–6 are the direct answer to your "official shape" question: **the shape exactly as written does not work.** Rows 9–10 are the practically relevant answer: **it works once wrapped as production would wrap it.**

### 3.2 Reproducibility — `10-repeat.ts` (N=5 per cell) and `12-rpcchannel-repeat.ts` (N=3)

| scenario | onClose fired | onDone fired | flowing | runs |
|---|---|---|---|---|
| official, sub=0, clean | **0/5** | 0/5 | `null` | 5 |
| official, sub=0, abrupt | **0/5** | 0/5 | `null` | 5 |
| official, sub=1, clean | **5/5** | 0/5 | `true` | 5 |
| official, sub=1, abrupt | **5/5** | 0/5 | `true` | 5 |
| production, sub=0, clean | **0/5** | **5/5** | `null` | 5 |
| production, sub=0, abrupt | **0/5** | **5/5** | `null` | 5 |
| production, sub=1, clean | **0/5** | **5/5** | `null` | 5 |
| production, sub=1, abrupt | **0/5** | **5/5** | `null` | 5 |
| production + RPCChannel, clean | **0/3** | 3/3 | `null` | 3 |
| production + RPCChannel, abrupt | **0/3** | 3/3 | `null` | 3 |
| official + RPCChannel, clean | **3/3** | 0/3 | `true` | 3 |
| official + RPCChannel, abrupt | **3/3** | 0/3 | `true` | 3 |

No flapping anywhere: every cell is 0/N or N/N.

### 3.3 Clean vs abrupt is indistinguishable — `14-abrupt-really-abrupt.ts`

Real `nodeStdioTransport()` + real `RPCChannel`:

| teardown | `onCloseFired` | `reason === undefined` | raw `end` count | raw `close` count | raw `error` |
|---|---|---|---|---|---|
| `child.stdin.end()` (FIN) | true | **true** | 1 | 1 | `null` |
| `child.stdin.destroy()` (RST) | true | **true** | 1 | 1 | `null` |

**Windows does not surface RST separately here**, so kkrpc's `onClose` cannot distinguish a clean shell exit from a killed shell. Both give `reason === undefined`. This matters if anything downstream wants to treat "shell died unexpectedly" differently from "shell exited".

### 3.4 Flow-mode baseline — `07-listen-triggers-resume.ts`

| listener | `readableFlowing` (sync after attach) |
|---|---|
| none / `end` / `close` / `error` | `null` (paused) |
| `data` | `true` |
| `readable` | `false` |

---

## 4. Reproduction

### 4.1 What you can actually run (the five probes promoted with this report)

These are self-contained and live in this directory. Run them from the repo root.

```powershell
# The consolidated final matrix (§3.1). Prints the whole table; no file written
# unless you pass a path. ~50s: 10 children, each on a 5s observation window.
bun run docs/probes/stdio-lifecycle/13-final-matrix.ts
bun run docs/probes/stdio-lifecycle/13-final-matrix.ts .temp/out-13.json

# Reproducibility for the RPCChannel cells (§3.2, last four rows). Drives 11 for
# you — N=3 matches the report and takes ~60s (4 scenarios × 3 runs × 5s).
$env:N="3"; bun run docs/probes/stdio-lifecycle/12-rpcchannel-repeat.ts

# Single-variable causal test (§1.6): subscribe() is what resumes stdin.
# See §4.3 for why the trailing pipe matters.
foreach ($m in @("official","production")) { foreach ($s in @("0","1")) {
  $env:MODE=$m; $env:SUBSCRIBE=$s
  "frame" | bun run docs/probes/stdio-lifecycle/09-subscribe-is-the-resumer.ts } }

# The discriminating lock-vs-flow cells (§1.5). Same fd-0 caveat.
foreach ($m in @("stub-paused","stub-resume","official-resume","production-resume")) {
  $env:MODE=$m; "frame" | bun run docs/probes/stdio-lifecycle/04-hypothesis-test.ts }

# The end-to-end probe 12 drives (§3.2), one cell's full JSON at a time
# (MODE = production | official).
$env:MODE="official"; "frame" | bun run docs/probes/stdio-lifecycle/11-production-rpcchannel.ts
```

Expected readings, as measured (see §3 for the numbers each cell should print):
`13` → `onCloseFired` true **only** for the two `official-rpc` rows; `09` →
`official`+`SUBSCRIBE=1` flips `onCloseFired` to true and `readableFlowing` to
`true` while the other three cells stay `null`; `04` → `stub-paused` false /
`stub-resume` true / `production-resume` false with
`resumeError: "TypeError: Invalid state: ReadableStream is locked"`.

### 4.2 What is NOT in this repo

This report was extracted from a 23-probe investigation (15 raw outputs) run under
`.temp/recon-stdio/probes-h6/` — a gitignored scratch directory that **no longer
exists on the authoring machine either**. The other 18 probes
(`00-identity`, `01b-lock-semantics-safe`, `02-coupling-matrix`, `03-real-kkrpc`,
`05-official-clean-room`, `06-independent-method`, `07-listen-triggers-resume`,
`08-what-resumes-stdin`, `10-repeat`, `14-abrupt-really-abrupt`, and their drivers)
and every `out-*.json` / `out-*-raw.txt` referenced in §3 are **not retrievable**.
Only the five probes above were promoted, because those are the ones that carry
the argument; the rest are cited as the provenance of the numbers in §3, not as
something you can re-run. §4.4 maps every table to its source. In short: §3.1,
§1.5 and §1.6 are independently reproducible from this directory; §3.2's
`10-repeat` rows (N=5), §3.3's abrupt table and §3.4's baseline are **reported
measurements** whose probe files are gone.

### 4.3 The fd-0 precondition (why the commands above pipe something in)

Every probe prints the raw `fstatSync(0)` verdict (`fd0Kind`) alongside its result
for a reason: **§3.1's ten rows were all measured with `fd0=fifo=true`**, so that
is the configuration these commands are meant to reproduce. Piping a byte in
(`"frame" | ...`) is what makes fd 0 a FIFO; launched bare from a terminal it
reads `chr=true`.

**Be honest about how weak that check is.** Running `04`/`09` bare and comparing
`fd0Kind` is the reliable part. I also ran all four `09` cells bare and got the
*same qualitative pattern* as the piped run — `official`+`SUBSCRIBE=1` still
reported `onCloseFired=true, readableFlowing=true` — because in this automation
harness a console fd 0 is already at EOF, so the resume fires a real `end`
immediately. **Do not read that as "the console case is equivalent."** The
`fd0Kind` value differs (`chr=true`), so it is not the measured configuration, and
the agreement is an artifact of how this harness supplies stdin rather than a
property of a real terminal. Pipe the input, and check `fd0Kind` matches the table
you are comparing against.

`13` and `11` do not need the pipe from you: `13` spawns its children with
`stdio: ["pipe","pipe","pipe"]`, and `11` is spawned that way by `12`. That is why
they assert/print `fd0=fifo=true` without help.

**Warning (a trap the original author hit):** the retired `02-driver.ts`
**overrode `MODE`** with its own default mode list
(`stream-only,stdin-only,…`). Running it against a probe that switches on `MODE`
silently tested the wrong shapes and produced one contradictory reading that had
to be discarded (§6). If you resurrect a driver, give it an explicit mode list —
or use the dedicated `12`/`13` drivers. `13-final-matrix.ts` asserts
`shapeHonored` per row for exactly this reason.

### 4.4 Provenance of every §3 number

| §3 table | Source probe | In repo? |
|---|---|---|
| §3.1 consolidated matrix | `13-final-matrix.ts` | **yes** — re-runnable above |
| §3.2 `12-rpcchannel-repeat` rows (last 4) | `12` → `11` | **yes** — re-runnable above |
| §3.2 `10-repeat` rows (first 8) | `10-repeat.ts` | no — reported only |
| §3.3 clean-vs-abrupt | `14-abrupt-really-abrupt.ts` | no — reported only |
| §3.4 flow-mode baseline | `07-listen-triggers-resume.ts` | no — reported only |
| §1.5 discriminating cells | `04-hypothesis-test.ts` | **yes** — re-runnable above |
| §1.6 single-variable test | `09-subscribe-is-the-resumer.ts` | **yes** — re-runnable above |

---

## 5. Unverified / uncertain

Stated plainly; each is a real gap, not a hedge.

1. **I did not test the actual Tauri shell.** Every measurement uses a bun-spawned child with a libuv pipe on fd 0. The real host is spawned by the Rust shell via `Stdio::piped()` (`src-tauri/src/host.rs`). Pipe semantics *should* be identical (both are Windows named pipes → `isFIFO()===true`), but I did not verify end-to-end. This is the single largest gap.
2. **`Kill`-based abrupt teardown is not covered.** My "abrupt" is `child.stdin.destroy()`, which §3.3 shows is *not* distinguishable from `end()` on Windows. A genuinely SIGKILLed peer was not tested (the `kill` mode in `14` was not run to completion). **I therefore cannot claim anything about RST specifically** — only that `destroy()` ≈ `end()` here. If you need true-RST coverage, that is a separate probe.
3. **`onClose` reason semantics are only partly characterized.** I confirmed `reason === undefined` for both teardowns and that kkrpc maps `error` → the error object (`stdio.ts:104-105`). I did **not** observe an `error`-reason close, so I cannot confirm the error path fires in practice.
4. **Not verified on POSIX.** `stdin-watch.ts` documents that libuv uses socketpairs on POSIX; my abrupt/clean findings may not transfer. All results are Windows-only.
5. **`RPCChannel` internal close propagation was not fully characterized.** My probe's `channelClosed` was `false` in every run and my `pendingOutcome` call was malformed (it resolved in 0–1 ms both shapes, i.e. it did not exercise a real in-flight call). **Do not read anything into those two fields.** Probe E's prior finding (pending call rejects ~303 ms when the *peer* closes) still stands on its own evidence; I did not re-verify it.
6. **I did not measure whether switching shapes changes actual `#33` behaviour.** I only measured that `onClose` becomes available. Whether `stopOnStdinLoss` wired to `onClose` behaves better or worse than the current pump `onDone` is untested — notably `onDone` fired reliably (5/5) in the production shape, so the current code is not obviously broken. **Answered by #38 — see §7.** `host/tests/stdin-loss.test.ts` now pins `onClose` as the sole stop trigger for the shell-attached path, and the pre-existing "shell-attached host stops" case still passes, so the swapped trigger is the same stop with one fewer source rather than a behaviour change.
7. **`process.stdin` shim internals are inferred, not read.** The `own()` → `getReader()` chain is inferred from the thrown stack (`at own (5:15)`) plus observed behaviour, not from bun's source. The *behaviour* is measured and reproducible; the *naming* of the internal function is from the error trace.
8. **One contradictory reading was discarded, not resolved by measurement.** See §6 — it is fully explained by a probe-harness bug, so I consider it settled, but I am flagging that I resolved it by reasoning about my own tooling rather than by re-running that exact configuration.

---

## 6. Honest note on a discarded reading

An intermediate run reported `production + RPCChannel` with `onCloseFired=true` 3/3, contradicting everything else. **It was a probe-harness bug**: `02-driver.ts` unconditionally overrides `MODE` with its default shape list, so the child ran as `stream-only` (my probe's `else` branch → `nodeStdioTransport()`) rather than `production`. Verified directly: that invocation prints `"shape": "stream-only"`.

Corrected with a dedicated driver (`12-rpcchannel-repeat.ts`), `production + RPCChannel` is `onCloseFired=0/3` as expected. `13-final-matrix.ts` now asserts `shapeHonored` on every row so this class of error cannot recur silently. I am recording this because it is the same *kind* of error that produced the original recon report's incorrect headline.

---

## 7. Recommendation — superseded by PR #38

**As originally written (kept verbatim, this is what the measurement alone supported):**

> **Do not switch to `nodeStdioTransport()` on the strength of the `onClose` finding alone** — it does make `onClose` work (3/3, both teardowns, vs 0/3 today), but it is not a drop-in replacement: `stdin-watch.ts`'s `Bun.stdin.stream().getReader()` and the official transport are **mutually exclusive** (measured: watch-then-official throws `ERR_INVALID_STATE`, and official-then-watch throws identically), so the "single reader" contract in `stdin-watch.ts:19-21` and `stdio.ts:229-235` must be redesigned in the same change, and the current pump-based `onDone` already fires reliably (5/5) so `#33` is not regressed today — i.e. switch only as a deliberate, tested refactor, not as a bug fix.

**Decision (PR #38): the switch was made, and it is safe.** This is the ruling the
report itself owes a reader, because §7 read cold says "do not" while the code now
does exactly that. The switch was made as the deliberate, tested refactor §7's own
final clause permits — **not** as a bug fix — and none of §7's three premises still
block it:

1. **The named blocker assumed the two readers must coexist; they do not.** §1.1's
   mutual exclusivity is real and unchanged. But §7 inferred from it that the
   single-reader contract would have to be *redesigned* so both could share. The
   shipped wiring keeps them **disjoint instead**: `host/src/index.ts` dispatches
   on `VRCXK_SHELL` — shell-attached takes the kkrpc transport, shell-less takes
   `watchStdinClose()` — so `stdin-watch.ts:19-21`'s contract ("exactly one
   reader") is preserved by *never* running both, not by teaching one stream two
   readers. `host/src/stdio.ts` states this as a standing rule ("Do NOT
   reintroduce a `Bun.stdin.stream()` reader here").
2. **The `onDone`-vs-`onClose` question in §5.6 is now measured, not assumed.**
   `host/tests/stdin-loss.test.ts` pins `onClose` as the sole trigger for the
   shell-attached path (asserting exactly one stop line, so a regression that
   re-added a second listener fails loudly), and the pre-existing "shell-attached
   host stops when the shell end of stdin goes away" case still passes. Routing
   `stopOnStdinLoss` from `onDone` to `onClose` is therefore the same stop with
   one fewer trigger — which is what §7 was right to demand evidence for.
3. **The side effect §7 did not weigh is absorbed at the call site.** kkrpc's
   `handleTransportClose` rejects **every** pending request *before* invoking
   `onClose`, so a shell that dies mid-handshake turns the in-flight
   `shell.ready` into a rejection that would reach the bootstrap catch-all and
   race the stdin-loss path over the exit code. `host/src/index.ts` now treats
   that rejection as an expected outcome, which is precisely what lets `onClose`
   be the *sole* trigger instead of needing a second stdin listener pair.

⇒ Only §7's operational warning survives verbatim: **this is not a drop-in bug
fix.** #38 shipped it with a regression test that was verified to go red when the
`bootstrap` change is reverted, so the claim is pinned rather than asserted.

**Scope note (still open, not resolved here):** the two readers cannot be made to
coexist *in one process*. §7's redesign would still be required for that, and
nothing in #38 attempts it.
