# Advisor board: charts instead of a wall of text

## Objective
Make the Advisor nav panel readable at a glance and show, with measured
numbers only, how much decision load the gate takes off the big model.

## Problem
`adapters/orca/panels/board.html` is six stacked sections of prose, stat
boxes and tables. Searching the shipped 0.3.1 panel for `<canvas`, `<svg`,
`chart`, `sparkline` and `donut` returns **zero** matches. The user has
asked for this three times; 0.3.0 and 0.3.1 changed 33 lines of this file
between them, none of them visual.

## Why
A number in a table is read; a proportion in a chart is seen. The two
things worth seeing here are proportions: how the gate's decisions split by
source, and how far apart Jev and the big model are on time.

## Scope (authorized)
- `src/core/ab_report.ts` (+ tests) — pure fold of the A/B results log.
- `adapters/orca/read-measurements.mjs` (+ tests) — expose that fold.
- `adapters/orca/panels/board.html` — the redesign.
- `scripts/screenshot-panels.mjs` — fixtures matching the real shapes.

Out of scope: the settings panel, the gate itself, any new measurement.

## Constraints
- **No invented numbers.** Every figure rendered must come from a log this
  plugin actually writes. Anything not measured gets named as not measured.
- **No money.** Efficiency is tokens and time, never dollars.
- **Name the model.** `claude-opus-5-5[1m]`, read from the log, never
  "the big model".
- Inline SVG only — the panel shell injects a short token allowlist and no
  libraries reach it.
- Both themes; 1440 / 768 / 390 / 320.

## Real data as of 2026-09-24 (the shapes the panel must render)
- gate: 2297 decisions — jev 2029, cache 149, local-rule 119;
  allow 2013, ask 279, deny 5; jev latency median 447 ms, max 1742 ms.
- A/B: 20 samples — Jev median 236 ms (203–784), `claude-opus-5-5[1m]`
  median 4126 ms (3155–7848); agree 11, disagree 9, every disagreement
  Jev `allow` / model `ask`.

## Tasks
- [x] T1 `src/core/ab_report.ts`: pure `foldAbResults` + tests (TDD, RED first).
- [x] T2 `read-measurements.mjs`: aggregate `ab-benchmark-results.jsonl` + tests.
- [x] T3 `board.html`: chart primitives (stacked bar, horizontal bars,
      latency comparison) as inline SVG, themed from the allowlist tokens.
- [x] T4 `board.html`: rebuild the six sections around them, plus the
      "what is not measured" card.
- [x] T5 fixtures in `screenshot-panels.mjs` matching `jevLatency` and the
      A/B fold — NOT the invented `latencyMs {median,p90}` shape.
- [x] T6 screenshots at four widths, both themes, read every image.

## Checks
`npm run check` (typecheck + 513 existing tests) and the screenshot harness.

## TDD
Strict TDD enabled (source: user CLAUDE.md). Runner:
`node --test --experimental-strip-types`.

## Delivery
`ask-on-risk`. Route: T1–T2 delegated writer; T3–T6 inline (visual
judgment and reading the screenshots stay with the parent).

## Progress
- Branch `feat/advisor-board-charts` created off `bfa7b84` (v0.3.1).
- T1-T2 delegated writer, 16 tests, commit `612234a`.
- T3-T6 inline, commit `1e0a35f`. Screenshots read at 1440/768/390/320 in
  both themes, `ready` and `fresh`.
- Two harness defects found by reading the images, both fixed in `1e0a35f`:
  the fixture had drifted to an invented gate shape (so every populated gate
  screenshot photographed the empty state), and the heartbeat went stale
  mid-run (so the dead-worker banner appeared on almost every image).

## Added scope: the silent fail-open (from MEJORAS-JEV-ADVISOR.md, P0)
Verified at `adapters/claude/gate-bash.ts:838` -- `outcome.kind === 'none'`
passes through writing nothing. The gate can be disarmed while the log looks
healthy, which makes the board's headline count silently low. Delegated:
`source: 'none'` recorded, one notice after three consecutive failures,
and the board showing that slice.

- [ ] T7 record and surface `source: 'none'`.
