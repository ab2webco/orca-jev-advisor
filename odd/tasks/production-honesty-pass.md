# Nothing in the panel says something it has not checked

## Objective
Remove every place where this plugin tells a developer something that is not
true, so the whole thing can be re-tested end to end without a known lie in it.

## Problem
Three releases in one day fixed real defects, and the pattern behind almost all
of them was the same: a surface reporting a state it never verified. The
remaining instances were found by measurement, not by reading:

1. **Four threshold fields are dead.** `actThreshold`, `confirmThreshold`,
   `reversibleGate` and `externalGate` are declared in `src/core/store.ts`,
   validated, defaulted, shown in the panel and editable — and read by no
   decision anywhere. Only `consequenceCeiling`, `jevBudgetMs`
   (`main.mjs:1235`) and `logMaxEntries` (`log.ts:75`) are live.
2. **The default config carries the ceiling we measured wrong.**
   `store.ts:335` has `consequenceCeiling: 1.5`; the constant in force is
   `GATE_CONSEQUENCE_CEILING = 1.78`. Third place this number has gone stale.
3. **The panel's `externalGate` fallback is 0.35** (`config.html:1568`) while
   `GATE_EXTERNAL_GATE` is 0.5 (`decisions.ts:353`). Same defect as the
   ceiling drift fixed in T7, different field.
4. **The skills mod can never be linked from the panel.** Node refuses
   `fs.symlink` unless granted full fs read AND write; the installer's sidecar
   is scoped on purpose, so the call fails with `ERR_ACCESS_DENIED` on every
   machine. Measured on two. The failure is then swallowed: the result stored
   for the panel is `{id, at, ok, reason, detail}` and drops `modLinkWarning`.
5. **"Linked" answers a question nobody asks.** The mod writes one line per
   prompt; on this machine the measurements file does not exist at all while
   the panel would happily report "linked". Plumbing, not evidence.
6. **Every deny writes a pending that can never be answered.** With nine rules
   denying, this is now the main channel into the calibration log, and
   `UNRESOLVED_AFTER_MS` discards those records instead of reading them.

## Why
A gate that is wrong is a bug. A gate that is wrong and says it is fine is the
thing this project keeps having to fix.

## Scope
`src/core/store.ts`, `src/core/decisions.ts`, `src/core/approval_record.ts`,
`adapters/orca/panels/config.html`, `adapters/orca/install-claude-integration.mjs`,
`adapters/orca/main.mjs`, and their tests.

## Out of scope
Policy seed upgrades, measurement-mode sampling, Windows verification.

## Delivery
Strategy: `ask-on-risk`. TDD: strict. Runner:
`node --test --experimental-strip-types`. 391 tests pass at `a7fceb3`.

## Tasks
- [x] P1 Every panel default comes from the constant it mirrors, or the field
      does not exist. One guard test that fails when a panel literal drifts
      from its source of truth, covering the ceiling AND the external gate.
- [x] P2 The four dead threshold fields are either wired to a decision or
      removed from the config, the panel and the store. Do not leave an
      editable control that changes nothing.
- [x] P3 `store.ts`'s default ceiling comes from `GATE_CONSEQUENCE_CEILING`
      rather than a literal.
- [ ] P4 The skills mod is copied rather than symlinked, with a content marker
      so an update replaces a stale copy; uninstall removes it.
- [ ] P5 A failed mod install reaches the panel instead of being dropped from
      the stored result.
- [ ] P6 The panel reports what the mod has DONE — not installed / installed
      but never run / recording N prompts since <date> — read from the
      measurements file, not inferred from a link.
- [ ] P7 A pending with no outcome past its TTL is classified `not-run` and
      counted as a stop that worked, rather than discarded. State in the code
      that this is a classification, not a certainty: a crash after the command
      ran leaves the same trace.

## Acceptance
- No panel control exists that no decision reads.
- No panel default contradicts its constant, and a test proves it.
- The skills mod install either succeeds or says why, in the panel.
- The panel's skills line is derived from recorded prompts.
- `not-run` appears in the approval summary with its own count.
- All tests pass; screenshots read at 1440/768/390/320 in both themes.

## Progress
Inventory measured and recorded above.

P1, P2 and P3 done on `fix/thresholds-honesty` (off `main`, not merged). P4-P7
belong to a different writer and were left untouched.

- **P2 decision: removed, not wired.** `actThreshold`, `confirmThreshold`,
  `reversibleGate` and `externalGate` are gone from `PluginThresholds`
  (`src/core/store.ts`), the config panel (`adapters/orca/panels/config.html`)
  and their validators/defaults. Confirmed by grep (whole `src/` and
  `adapters/`, excluding tests/panels/i18n) that no decision anywhere read
  them, matching this doc's own inventory. Backward compatible: a stored
  config still carrying the four keys loads through unchanged, because
  `isPluginThresholds` now only requires `consequenceCeiling` to be a number
  and ignores unknown keys instead of rejecting the object.
  - Caveat this pass surfaced: `consequenceCeiling` on `PluginConfig.thresholds`
    (the one field this doc named as live) is *also* not read by any decision
    at runtime -- `gate-bash.ts`'s `decideGateAction` call takes its ceiling
    from `catalog.ts`'s per-destination `autonomy.consequenceCeiling` (a
    different, live object with the same field name) or straight from
    `decisions.ts`'s `GATE_CONSEQUENCE_CEILING`, never from `getConfig()`.
    Only `jevBudgetMs` (the sibling field) is actually consumed, in
    `main.mjs`'s `cmdDecide`. Kept the field per this task's explicit
    instruction (P3 says to fix its default, not remove it) rather than
    expanding scope; flagged here rather than silently agreeing with the
    inventory.
- **P3.** `DEFAULT_CONFIG.thresholds.consequenceCeiling` in `store.ts` now
  imports and uses `GATE_CONSEQUENCE_CEILING` from `decisions.ts` instead of
  repeating `1.5`.
- **P1 guard.** New test `adapters/orca/panels/config_html_thresholds.test.mjs`
  reads `config.html` as text (it cannot import from `src/core`) and asserts:
  the four removed fields have no input element and no `el(id)` reference
  left in the panel; `consequenceCeiling`'s fallback chain never hardcodes a
  bare decimal (only defers to the worker-published `gateDefaults` mirror or
  stays blank). A self-check test proves the detector actually flags the
  historical shape of the defect (`... : 1.78`) before trusting it against
  the real file. `externalGate`'s own drift (0.35 vs `GATE_EXTERNAL_GATE`
  0.5) is moot: the field no longer exists, so there is nothing left to drift.

Tests: `node --test --experimental-strip-types` -- 398 pass (391 baseline +
4 in `store.test.ts` + 3 in the new panel guard file), 0 fail. Extracted
`config.html`'s inline `<script>` and ran `node --check` on it: syntax OK.

Not verified: panel screenshots (developer takes those; not run here).
