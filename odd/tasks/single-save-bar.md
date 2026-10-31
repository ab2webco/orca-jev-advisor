# One save bar for the config panel

## Objective
The config panel has a separate Save button per section and, on the Models tab, four per account (mode, work kind, effort, context guardian). With several accounts that is a dozen clicks, and saving one router row redraws every row, which drops unsaved edits on the others. The owner asked for one save after choosing everything, in every tab, and for shorter copy ("esos párrafos de texto no ayudan", 2026-10-30).

## Scope
- **T1 (worker):** `attendModelRouterConfigRequest` (`adapters/orca/main.mjs`) also accepts a batch, `changes: [{ target, mode?, workKind?, effort?, steward? }]`. It runs every item one after another, keeps going after a failure, returns a result for each item, and publishes status once. The existing single-field shape is unchanged.
- **T2 (panel bar):** `#save-all` becomes the one save bar. It stays visible on every tab, is sticky, shows "Save changes (N)" or "No changes", and has a Discard.
  - **Dirty tracking:** per section and per router field.
  - **Validation first:** every check runs before the first write, so one error writes nothing. That covers invalid fields, the guardian 10..2000 range, and unread sections.
  - **Write order:**
    1. The current direct writes, unchanged: every loaded section is still written.
    2. Models ladder and config.
    3. Skill and tool selection, then the deny tier.
    4. One router batch.
  - **Gating and stale values:** a section whose module is off is skipped and named. A router field that went stale is reported and not written, and the other pending edits survive the redraw.
  - **Buttons removed:** the per-section and per-row save buttons. Hint anchors that pointed at them are moved first.
  - **Apply guard:** "apply marked" on catalog or policies is refused while that section has unsaved edits, as models already does.
- **T3 (copy):** every long section hint becomes one short line (`*.hintShort`, es/en), with the full text inside a "What is this?" disclosure. Stale cross-references are fixed.
- **T4:** README, CHANGELOG, shots.

## Not under the bar (by design)
- **Secrets and credentials** (Jev key, Cloudflare) keep their own buttons. They use the heartbeat and tombstone guard.
- **Module state buttons** (General) apply on click. If they were deferred, a module turned on in the same batch would time out its own section's save.
- **"Apply marked" / "Add" on proposal and diff lists** act on a review list and stay immediate.

## Checklist
- [x] T1 worker batch request, additive
- [x] T2 one bar, dirty tracking, ordered saves, per-row buttons gone, tests moved to `#save-all`
- [x] T3 short hints with disclosure, es/en
- [x] T4 docs, CHANGELOG, shots looked at (config tabs, es and en, 1440, 768, 390, 320, both themes)

## Acceptance criteria
- Strict TDD: RED observed before each GREEN.
- **Router batch:** edits on two router targets plus skill selection, then one `#save-all` click, send one router batch request and one skill-selection request.
- **Stale field:** a stale field on one target leaves the other targets' pending edits intact and visible.
- **Validation:** a validation error anywhere writes nothing anywhere.
- **Shots:** 1440, 768, 390 and 320, both themes. At 320 the sticky bar does not cover the last control.

## Checks
`npm run typecheck`, the touched unit tests, `npm run test:panels`, `npm run shots`, and `npm run check` in an isolated worktree.

## Notes
- Stacked on `feat/tool-selection-off` (not merged yet).
- The Engram mirror `odd/single-save-bar/tasks` is pending: Engram was disconnected on 2026-10-30.
- About 400+ lines across worker, panel and copy, so it is planned as chained PRs: T1, then T2, then T3+T4.
- Stale router field (decided 2026-10-30, not yet put to the owner): a field that changed outside the panel between load and save is left out of the batch, and its row shows the real value with the "changed outside this panel" message. It is not kept pending, so a save never overwrites someone else's newer choice. A refused field stays pending and counted.
- Left as is: the Memory card's live readouts (`modules.memory.active.live` and the weekly line, up to about 319 characters) are status lines, not hints, and still wrap over several lines.
