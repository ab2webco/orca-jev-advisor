# Release 0.6.27: the panel shows the verified compaction saving

## Objective
The owner, 2026-10-06, after the value report:
- "pero el informe no dice nada bueno esto como se puede mejorar ?";
- "esto que sea real me preocupa tu cambio y que sea invento";
- "sí, hazlo en una rama nueva con TDD".

The context steward is the plugin's one measured saving, but the board shows it wrong. Its "freed per step" line uses the plugin's own `tokensAfter`, which leaves out the system prompt and tools reloaded after a compaction. Measured against real usage, the real drop is 84% of that figure (median, 32 compactions). The line also never says how much was saved in total.

Verified by hand on 2026-10-06:
- 32 of 59 applied compactions are traceable.
- 1.38 B tokens the main agent did not re-read, 28% of its context.
- The 27 rows without a `sessionId` all fall in the hours when the stale 0.6.10 install ran (2026-10-03 13:14 to 2026-10-04 21:25), or predate the field (before 2026-09-30 23:37). Current code always logs it, so there is no fix to make there.

## Scope
- **T1 (core):** `verifyStewardSaving(stewardRows, usageRows, nowMs, windowMs)` in `src/core/context_steward.ts`, a pure function:
  - Per-step context is input + cacheRead + cacheWrite, from `agent === "main"` usage rows only.
  - For each applied compaction in the window with a `sessionId`: the drop is the last main step strictly before it minus the first strictly after it, in the same session. Skip the compaction when either side is missing or the drop is ≤ 0.
  - The saving is the drop × the main steps after the compaction, up to the next applied compaction in that session or the end of the data.
  - Timestamps are compared with `Date.parse`. Rows are grouped by session once.
  - It returns `compactions`, `verified`, `steps`, `tokensNotReread`, `mainContextTokens` and `share`.
- **T2 (reader):** `read-consumption.mjs` adds the result to `steward.verified`, over the last 7 days, which is the usage window and the pruning horizon.
- **T3 (panel):** when a verified saving exists, the board's steward block shows it, in English and Spanish, and replaces the overstated freed-per-step line. Without one, the old line stays. Covers panels.spec and the screenshot fixtures.
- **T4:** README, CHANGELOG, version 0.6.27, QA, release, catalog and live check.

## Checklist
- [x] T1 core function (b28fba8, fix 91e1de2: RED missing export, then 7 assertion fails; GREEN 47/47)
- [x] T2 reader (1deee29: RED 2, GREEN 19/19)
- [x] T3 panel (f6c3a49, a0ba9b1: RED then GREEN; test:panels 194/194; shots looked at in 4 widths and 2 themes)
- [ ] T4 docs, release, live check (docs, version and QA written; release and live check pending)

## Acceptance criteria
- Strict TDD: RED observed per rule, then GREEN. Typecheck 0, `npm test` green, `npm run test:panels` green.
- The real `read-consumption.mjs`, run against `~/.cache/orca-supervisor`, reproduces the report's figure (1.38 B, 28%, plus whatever steps were added since).
- Board shots at 1440, 768, 390 and 320, both themes, looked at.
- Live: after the marketplace update, the board shows the verified line.

## Checks
`npm run typecheck`, `npm test`, `npm run test:panels`, `npm run shots`, and a real-data run of `adapters/orca/read-consumption.mjs`.
