# Probe output — the evidence behind `../FINDINGS.md`

**These `*-report.txt` files are checked in on purpose.** Every claim in
`FINDINGS.md` points at a number here, so a reader can verify the document
instead of trusting it.

| File | Produced by | What it shows |
|---|---|---|
| `matrix-report.txt` | `01-transport-matrix.mjs` | 56 cells × 3 repeats: encoding, transport, direction, frame size, client implementation |
| `backpressure-report.txt` | `02-backpressure.mjs` | the producer stops at the **32-chunk credit window**; the ungated control reaches 2048 |
| `hol-report.txt` | `03-head-of-line.mjs` | RPC latency while a bulk transfer runs on the same connection |
| `priority-report.txt` | `04-shared-vs-separate.mjs` | shared tunnel vs a separate connection |
| `evloop-report.txt` | `05-event-loop.mjs` | event-loop lag per file API; the **`Buffer.alloc` freeze** |
| `folder-report.txt` | `06-folder-upload.mjs` | one request per file vs one packed blob (RTT-dependent) |
| `conc2-report.txt` | `07-concurrency.mjs` | concurrency scaling (1.26x) and its memory cost |

## ⚠ The raw `*.json` are NOT committed (deliberate)

Each probe also writes a machine-readable `*.json` beside its report. Those
**used to be checked in** and were removed on purpose:

- They are **regenerable output**, not source. The probe writes them itself
  (`01-transport-matrix.mjs` ends in a `writeFileSync`), so committing them
  duplicates what one re-run produces.
- `matrix.json` alone was **1,273 lines** — more than every report here combined,
  for a file whose figures the report already states.
- Keeping them invited them to go **stale**: a committed measurement looks
  authoritative long after the machine it ran on changed.

**What is lost:** you can no longer recompute an aggregate without re-running.
That is accepted — the claims that matter are **in the reports**, and the point of
keeping evidence is to make `FINDINGS.md` checkable, not to avoid re-running.

## Re-running overwrites these

That is intentional: the numbers ARE the evidence, so a probe that produces
different results should **show up as a dirty working tree** rather than be
silently ignored. If a re-run changes a figure, `FINDINGS.md` has to be updated
with it — the document and this directory must not disagree.

A re-run writes `*-report.txt` **and** a fresh `*.json`; the latter is
`.gitignore`d, so a dirty tree after a run means the reports changed.

One practical note:

- **`matrix.json` is written by a full `--repeats=3` run.** A `--quick` run writes
  a smaller file and would make the report look like cells went missing — if you
  are regenerating it, use the full run.
