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

**Extended during P4-P7** (not in the original list above, touched because
P6 and P7's own acceptance criteria require it): `adapters/orca/read-
measurements.mjs` (the only place that reads mod-skills-measurements.jsonl
and gate-approvals.jsonl into a summary) and `adapters/orca/panels/
board.html` (the only panel that renders the approvals summary at all --
config.html never did). Leaving these as they were would have shipped P6/P7
half-connected: a correct `ApprovalSummary.notRun` in approval_record.ts
that a consumer still called `unresolved` and silently read as `undefined`
is exactly the class of defect this whole pass exists to remove.

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
- [x] P4 The skills mod is copied rather than symlinked, with a content marker
      so an update replaces a stale copy; uninstall removes it.
- [x] P5 A failed mod install reaches the panel instead of being dropped from
      the stored result.
- [x] P6 The panel reports what the mod has DONE — not installed / installed
      but never run / recording N prompts since <date> — read from the
      measurements file, not inferred from a link.
- [x] P7 A pending with no outcome past its TTL is classified `not-run` and
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

### P4-P7, on `fix/skills-mod-truth` (off `fix/thresholds-honesty`, not merged)

Branched off `fix/thresholds-honesty` at `c126c79` (400 tests passing) per
the coordinator's instructions, to avoid the same-file conflict with PR #9.
`src/core/store.ts` and the panel's threshold section were left untouched,
as instructed.

**P4 -- copy instead of symlink.** Measured claim confirmed by reading
`gate-bash.ts`'s own module docstring cross-referenced against Claude Code's
hook contract: a PreToolUse hook that itself returns `permissionDecision:
'deny'` never triggers Claude Code's own permission dialog, so
`PermissionDenied` cannot fire for it -- consistent with the sidecar always
running under `main.mjs`'s scoped `--allow-fs-write` grant, never
unscoped. `installModLink`/`uninstallModLink`/`currentModLinkTarget`
replaced with `installModCopy`/`uninstallModCopy`/`modCopyState` in
`adapters/orca/install-claude-integration.mjs`: `cp(source, dest,
{recursive:true})` instead of `symlink()`, a marker file
(`.orca-jev-mod-skills.source.json`, sibling to the copy, recording
`{source, copiedAt}`) as the update signal, idempotent re-install (marker
match + real directory = no-op), and a one-time migration path that
recognizes a pre-fix symlink by its own target when no marker exists yet
(covers both "install migrates it to a copy" and "uninstall still removes
it"). Dropped the symlink branch entirely rather than keeping an
unreachable-under-test "try full-permission symlink first" path -- reasoning
recorded in the module's own comment. Result field renamed `modLink` ->
`modCopy` throughout (`install-claude-integration.mjs`, `main.mjs`,
`config.html`) since a copy is not a link; nothing external depended on the
old name.
  - Test: `node --test --experimental-strip-types adapters/orca/install-
    claude-integration.test.mjs` -- 17/17 pass (8 pre-existing + 9 new: real
    copy not symlink, marker written, idempotent no-rewrite, stale-copy
    replacement, symlink migration on install, uninstall removes owned
    copy+marker, uninstall leaves a foreign directory alone, uninstall still
    removes a markerless legacy symlink by target, and the P5 warning test
    below).

**P5 -- the failure reaches the panel.** `installModCopy` returns a stable
reason code (`'copy-failed'`, never the raw English detail string -- same
convention as every other `reason` in this codebase) when `cp()` throws;
`install()` already surfaced this as `modCopyWarning` per-target and at the
top level (this was true before my change too -- the actual defect was
entirely downstream). Fixed the drop: `attendClaudeIntegrationRequest` in
`main.mjs` used to hand-build `{id, at, ok, reason, detail}` for
`CLAUDE_INTEGRATION_RESULT_KEY`, discarding `modCopyWarning`. Extracted that
shaping into `claudeIntegrationResultPayload(id, result)` (exported, unit-
tested directly -- the install/uninstall path itself is NOT exercised in
`main.test.mjs`, deliberately: it spawns install-claude-integration.mjs for
real against the real `~/.claude`, and the existing suite already avoids
that for exactly this reason). `config.html`'s setup-click handler used to
discard the resolved result entirely (`.then(function () {...})`); it now
inspects `result.modCopyWarning` and renders `integration.doneWithWarning`
(mapping the reason code through a catalog, `MOD_COPY_WARNING_KEYS`, the
same pattern as the existing `ERROR_REASON_KEYS` -- never raw English
prose) instead of a blanket "Done.".
  - Test: `claudeIntegrationResultPayload carries modCopyWarning through`
    and its null-case sibling, in `adapters/orca/main.test.mjs` -- both
    pass (35/35 in that file). Panel-side: `config.html: the setup click
    handler surfaces a returned modCopyWarning...` in the new
    `config_html_mod_skills.test.mjs` -- confirmed this fails against the
    pre-change panel (see below), passes now.

**P6 -- report what the mod has DONE.** Three states, derived from
`mod-skills-measurements.jsonl` via the existing `read-measurements.mjs`
sidecar (already read by `board.html`; `config.html` never read it before
now, so this is new plumbing there, not new plumbing overall):
`not installed` (`!status.modCopy.exists`), `installed but never run`
(exists, `totalDecisions === 0`), `recording` (count + `firstAt`/`lastAt`,
newly added to `aggregateModSkills`, computed from the actual decision
timestamps -- never file order, and immune to a malformed line elsewhere in
the file). `status()`'s per-target and aggregate shape gained
`modCopy.exists` alongside the renamed `modCopy.installed` (`installed`
kept its old meaning -- current for this exact plugin root -- because a
stale-but-present copy from an older version can still have produced real
measurements worth reporting; `checkClaudeIntegration`'s doctor check
updated to match). Old "linked"/"linked in N of N places" vocabulary
removed from both catalogs entirely, including `integration.modLinked`
(singular), which was dead code already -- defined in both catalogs, never
read by any `t()` call, found while removing its siblings. Also fixed the
message text and hint copy that still said "a link to the skills mod".
  - Test: `adapters/orca/read-measurements.test.mjs` (new) -- 3/3 pass,
    covering the no-data/null case, chronological-not-file-order, and
    malformed-timestamp resistance. `config_html_mod_skills.test.mjs` (new)
    -- 8/8 pass, including a regression guard on the exact historical bug in
    the code being replaced: the old `modLinkedCount` line rendered
    `{installed: status.hook.totalCount, total: status.hook.totalCount}` --
    the Bash-hook install count standing in for a completely unrelated
    number (recorded prompts) it shares no relationship with. Confirmed by
    `git stash`-ing the `config.html` change and re-running this test file
    alone: 6 of 8 fail against the pre-change panel (the syntax-check and
    modLink-absence tests pass either way, as expected), then restored.

**P7 -- a refused command is the only evidence the gate ever earns.**
Verified the "nine rules deny" figure directly against
`adapters/claude/gate-bash.ts`'s `NEVER_SILENTLY` array before citing it:
exactly nine entries. Confirmed `appendPendingApproval` fires for `deny`
verdicts too (`if (resolved.decision !== 'allow')`), not only `ask` --
meaning a `gate-pending` record already exists for every outright denial,
and by construction can never receive an outcome (no PostToolUse,
PostToolUseFailure, or PermissionDenied hook can fire for a command a
PreToolUse hook itself refused). `summarizeApprovals`'s `unresolved` field
renamed to `notRun` in `src/core/approval_record.ts`, with the epistemic
caveat written directly into `ApprovalSummary.notRun`'s own doc comment
(two indistinguishable causes producing the identical trace: an outright
deny vs. a session that crashed after the command ran and before
gate-outcome.ts's best-effort append) -- following `ceilingEvidence`'s own
precedent of returning null rather than dressing a coin flip as a
measurement: `notRun` is still never folded into `labelled`, so it
contributes zero evidence to the suggested ceiling either way. Propagated
through `read-measurements.mjs`'s `aggregateApprovals` (field rename) and
`board.html` (the only panel that renders this summary -- `config.html`
never did): the "Unanswered"/"Sin responder" tile is now "Did not
run"/"No corrió", with a new explanatory hint (shown only when the count is
non-zero) stating plainly that this is a classification, not a confirmed
fact.
  - Test: `src/core/approval_record.test.ts` -- 14/14 pass (13 pre-existing,
    field-name updated in place where they referenced `unresolved`, + 1
    genuinely new: a still-labelled outcome that arrives after the TTL has
    passed is never downgraded to `notRun` -- proving the classification
    only ever applies to a pending with NO outcome, never overrides a real
    one). `read-measurements.test.mjs`'s fourth test covers the
    `aggregateApprovals` rename specifically (asserts the old field name is
    gone, not just that the new one exists).

**Known gap, not fixed (scripts/ is off-limits):**
`scripts/screenshot-panels.mjs`'s `measurementsSummary` fixture still uses
`unresolved: 0` (the pre-P7 field name). It will not crash --
`board.html`'s render falls back to `|| 0` -- but a screenshot taken through
that script's fixture will show "0" for the "Did not run" tile regardless
of the real value. Flagging rather than touching it, per the explicit
constraint.

**Verification commands run:**
- `node --check adapters/orca/install-claude-integration.mjs`: OK.
- `node --check adapters/orca/main.mjs`: OK.
- `node --check adapters/orca/read-measurements.mjs`: OK.
- Extracted `config.html`'s inline `<script>` -> `node --check`: OK.
- Extracted `board.html`'s inline `<script>` -> `node --check`: OK.
- `node --test --experimental-strip-types` (full suite): 424 pass, 0 fail --
  400 baseline + 9 (install-claude-integration.test.mjs, 8 -> 17) + 2
  (main.test.mjs, 33 -> 35) + 8 (config_html_mod_skills.test.mjs, new file)
  + 4 (read-measurements.test.mjs, new file) + 1 (approval_record.test.ts,
  13 -> 14) = 424, exactly matching the harness's own reported total.
- `shasum ~/.config/orca-supervisor/policies.json ~/.config/orca-supervisor/
  catalog.json ~/.claude/settings.json`: identical before and after every
  run (`8ef0096b...`, `0b7a98a3...`, `2af89211...` respectively) -- the
  developer's real files were never touched. All installer/measurements
  tests spawn the real subprocess but always against a freshly created
  `mkdtempSync` HOME with `ORCA_USER_DATA_PATH`/`XDG_CONFIG_HOME`/
  `XDG_CACHE_HOME` cleared from the child's env.

Not verified: panel screenshots at 1440/768/390/320 in both themes --
per the report-back instructions, the developer takes those; none were
captured here, and none of this should be read as "the panel renders
correctly."
