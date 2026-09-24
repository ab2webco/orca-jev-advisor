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
- [ ] P1 Every panel default comes from the constant it mirrors, or the field
      does not exist. One guard test that fails when a panel literal drifts
      from its source of truth, covering the ceiling AND the external gate.
- [ ] P2 The four dead threshold fields are either wired to a decision or
      removed from the config, the panel and the store. Do not leave an
      editable control that changes nothing.
- [ ] P3 `store.ts`'s default ceiling comes from `GATE_CONSEQUENCE_CEILING`
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
Inventory measured and recorded above. Not started.
