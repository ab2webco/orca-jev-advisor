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
      rather than a literal. **Moot as of the Progress note below**: the
      default this fixed no longer exists (`consequenceCeiling` was removed
      from the editable config as a fifth dead field). Marked done because
      there is nothing left to do, not because the fix still stands.
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

- **P2 decision (first pass): removed, not wired.** `actThreshold`,
  `confirmThreshold`, `reversibleGate` and `externalGate` are gone from
  `PluginThresholds` (`src/core/store.ts`), the config panel
  (`adapters/orca/panels/config.html`) and their validators/defaults.
  Confirmed by grep (whole `src/` and `adapters/`, excluding
  tests/panels/i18n) that no decision anywhere read them, matching this
  doc's own inventory. Backward compatible: a stored config still carrying
  the four keys loads through unchanged, because the validator ignores
  unknown keys instead of rejecting the object.
  - Caveat this pass surfaced: `consequenceCeiling` on `PluginConfig.thresholds`
    (the one field this doc named as live) is *also* not read by any decision
    at runtime -- `gate-bash.ts`'s `decideGateAction` call takes its ceiling
    from `catalog.ts`'s per-destination `autonomy.consequenceCeiling` (a
    different, live object with the same field name) or straight from
    `decisions.ts`'s `GATE_CONSEQUENCE_CEILING`, never from `getConfig()`.
    Flagged rather than acted on, since P3 as written only asked to fix this
    field's default, not remove it.
- **P3 (first pass).** `DEFAULT_CONFIG.thresholds.consequenceCeiling` in
  `store.ts` imported and used `GATE_CONSEQUENCE_CEILING` from
  `decisions.ts` instead of repeating `1.5`. Superseded below.
- **P1 guard (first pass).** New test
  `adapters/orca/panels/config_html_thresholds.test.mjs` read `config.html`
  as text (it cannot import from `src/core`) and asserted the four removed
  fields had no input element or `el(id)` reference left, and that
  `consequenceCeiling`'s fallback chain never hardcoded a bare decimal.
  Extended below.

### Update: the caveat was right -- it was five dead fields, not four

The coordinator verified the caveat above independently: `getConfig()` has
exactly two callers in the whole codebase, `src/core/log.ts:63`
(`logMaxEntries`) and `adapters/orca/main.mjs:1226` (`jevBudgetMs`).
`consequenceCeiling` was never one of them. Acted on this correction rather
than preserving the original task description's boundary:

- **`consequenceCeiling` removed from the editable config entirely.**
  `PluginConfig` no longer has a `thresholds` object at all -- `PluginThresholds`
  and `isPluginThresholds` are gone from `src/core/store.ts`, and
  `GATE_CONSEQUENCE_CEILING` is no longer imported there (nothing in that
  file uses it anymore). `PluginConfig` is now just `{ logMaxEntries,
  jevBudgetMs }`. Keeping an empty `thresholds: {}` wrapper around zero live
  fields would have been a smaller copy of the same defect, so the wrapper
  went too, not just the one field.
  - Backward compatibility preserved the same way as the first pass: a config
    saved before this change still has a `thresholds` object with all five
    old keys sitting in storage; `isPluginConfig` no longer looks at
    `thresholds` at all, so it's ignored, not rejected. Proved by test (see
    below).
- **P3 is moot.** The default it fixed (`consequenceCeiling: 1.5` ->
  `GATE_CONSEQUENCE_CEILING`) no longer exists, because the field it defaulted
  is gone. Its checkbox above is marked done because there is nothing left to
  do, not because the fix still stands.
- **The number is still shown -- read-only.** `adapters/orca/panels/config.html`'s
  `consequenceCeiling` input became an `<output>` element: not part of
  `readConfig()`'s saved object anymore, sourced only from the worker's
  published `gateDefaults` mirror (`GATE_DEFAULTS_KEY`, unchanged -- that was
  already an import, never a literal, so no drift risk there). Added
  explanatory copy in both catalogs: this is the ceiling the gate applies by
  default, a destination can override it from its own catalog row, and the
  number comes from measurement, not preference. The "Save configuration"
  blank-ceiling guard is gone too -- there is nothing left to guard.
- **Section renamed.** With only a read-only ceiling and the editable log
  size left in it, "Thresholds"/"Umbrales" no longer described the section.
  Renamed to "Gate ceiling & log size" / "Techo del gate y tamaño del log"
  in both catalogs, and updated the one in-panel cross-reference that named
  the old heading (`modSkills.hint`, both languages).
- **P1 guard extended.** `config_html_thresholds.test.mjs` now also asserts
  that none of the FIVE fields (the four removed ones plus
  `consequenceCeiling`) has an editable `<input>` element anywhere in the
  panel -- a regex-based check independent of whatever value the field might
  show, so it catches a reintroduced editable control even if its fallback
  value happens to be correct. A self-check test proves the detector flags a
  synthetic `<input id="consequenceCeiling">` and correctly ignores the real
  `<output>`. Also asserts `readConfig()` no longer builds a `thresholds`
  object at all.

Tests: `node --test --experimental-strip-types` -- 400 pass, 0 fail (391
baseline + 3 in `store.test.ts`'s config section + 6 in the panel guard
file). Extracted `config.html`'s inline `<script>` and ran `node --check` on
it after each round of panel edits: syntax OK both times.

Not verified: panel screenshots (developer takes those; not run here).
