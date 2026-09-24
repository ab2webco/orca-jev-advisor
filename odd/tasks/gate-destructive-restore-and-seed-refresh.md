# The gate lets `git checkout --` and `git restore` discard work, and the seed says nothing about it

## Objective
Close the deny-rule hole that let an agent discard uncommitted work with
`git checkout -- <file>`, make the docs describe the deny tier the code
actually ships, refresh the shipped team-policy seed against current
behavior, and hand the cache redesign a reviewed plan.

## Problem
- `NEVER_SILENTLY`'s `rule.resetClean` (`adapters/claude/gate-bash.ts`) only
  matches `git reset --hard` / `git clean -f`. `git checkout -- <path>`,
  `git checkout .` and `git restore <path>` discard uncommitted work the same
  way, with no reflog behind them, and reach Jev instead -- where they score
  1.74-1.84, on both sides of the 1.78 ceiling (odd/CHECKPOINT.md).
- `commandFamily` files them under `git`, so the board cannot group them with
  the destructive family.
- Doc blocks in `gate-bash.ts` and `src/core/deny_tier_config.ts` still say
  only 3 of 9 rules deny and that reset/clean "stays ask";
  `DEFAULT_DENY_TIER_SWITCHES` is all `true`.
- `seed/policies.json` has no row about discarding uncommitted work.

## Scope
T1-T3 below, one PR to `main`. Not in scope: the cache redesign (a later SDD
change), `git switch --discard-changes` / `git switch -f` (the brief
explicitly leaves `git switch` uncaught -- recorded as a known gap).

## Constraints
`src/core` pure; `src/core/paths.ts` guard; no invented numbers; strict TDD.

## TDD
Mode: strict, ON (source: coordinator brief + odd/CHECKPOINT.md).
Runner: `npm test` (`node --test --experimental-strip-types`). Baseline 637/637.

## Delivery
Strategy: single PR (coordinator brief). RDD on globally: per work-unit commit
run `gentle-ai review assess --committed-only`.

## Tasks

- [x] **T1** Destructive checkout/restore rule, docs, family alignment.
  Route: inline (3 source files + 2 test files, understood).
  - Caught: `git checkout -- <path>`, `git checkout -- .`, `git checkout .`,
    `git checkout <ref> -- <path>`, `git checkout -f` / `--force` (with or
    without branch), `git restore <path>`, `git restore .`,
    `git restore --worktree ...`, `git restore --source=<ref> <path>`.
  - Not caught: `git checkout <branch>`, `git checkout -b <new>`,
    `git checkout -B <name>` (resets a branch pointer, carries the worktree
    over), `git switch ...`, `git restore --staged <path>` / `-S` (index only),
    bare `git checkout <name>` (branch-or-path ambiguity; left uncaught).
  - Checks: table-driven tests in `adapters/claude/gate-bash.test.mjs`,
    unit tests for the pure matcher and the family.
- [x] **T2** Refresh `seed/policies.json`. Route: inline (one data file).
  Checks: `src/core/policy_seed*.test.ts` green.
- [x] **T2b** (scope addition from the coordinator, user requirement)
  Baseline policy updates must reach existing installs.
  1. Give `seed/policies.json` a baseline version. The schema change is allowed;
     keep row-by-row tolerance and a test for the old bare-array shape.
  2. Record per install which baseline version was last offered (its own
     storage marker, like POLICY_SEED_MARKER_KEY).
  3. When the shipped version is newer than the offered one, compute
     `mergePolicySeeds` (added + differing) and show a notice in config.html
     Team policies (ES + EN) with the real counts and a button into the
     existing import/choose flow.
  4. Never auto-apply. Rows change only via `applyPolicySeedChoices` with ids
     the person picks. Dismissing marks the version as offered.
  5. No invented counts: only computed numbers, and nothing shown when
     nothing is new.
  Checks: strict TDD; `npm run check` with screenshots at 1440/768/390/320,
  both themes, each one read. Version comparison and merge stay in src/core;
  storage stays in main.mjs.
- [x] **T3** Append "Plan review findings (2026-09-24)" to odd/CHECKPOINT.md.
  Route: inline (docs).

## Progress / evidence

### T1
- Route: inline. Trigger evidence: 1 new pure module + 3 edited sources, all
  already read; no design question open.
- Design: the matcher is a pure function (`src/core/git_discard.ts`), not a
  regex, because a line regex cannot tell `git checkout -- x` from
  `git log -- .` or `git checkout main && ls .`. It is a sibling rule under
  the same `denyResetClean` switch and the same `rule.resetClean` reason.
  `NEVER_SILENTLY` and `FAMILY_PATTERNS` now take anything with
  `test(string)`, so the RegExp entries are unchanged.
- `-B` decision: not caught. It resets a branch pointer; the working tree is
  carried over like any checkout.
- Bare `git checkout <name>`: not caught (branch-or-path ambiguity), comment in
  `git_discard.ts`.
- Family renamed `git reset/clean` -> `git discard`. The family is stamped at
  write time, so `canonicalCommandFamily` maps the old label on read
  (`adapters/orca/read-measurements.mjs`), so a log from before the rename
  does not show the family twice.
- Stale docs fixed: `gate-bash.ts` NEVER_SILENTLY preamble,
  `deny_tier_config.ts` module note (two spots), `main.mjs` deny-tier comment.
- Not changed: the panel hint `denyTier.resetCleanHint` still describes only
  untracked files; changing it would need screenshots, so it is left for later.
- Known gap: `git switch --discard-changes` / `git switch -f` are left uncaught,
  as the brief asks.
- RED (observed): 12 gate subprocess cases got a non-deny verdict, the reader
  alias test failed, and `git_discard.test.ts` / `gate_measurement.test.ts` failed
  because the module was missing.
- GREEN: `npm test` -> 708/708 pass.
- Gate false positive seen live, twice: the installed gate (the old build,
  plugin dir under Orca's userData, not this branch) refused Bash commands
  whose text quoted the reset/clean phrase, once inside a `python3 - <<'EOF'`
  body, once inside an edit script. Nothing was being discarded. Edits were
  redone with the editor tool. Not fixed here (see T1 follow-up for why the
  new matcher does not repeat this for checkout/restore).
- Commit `fd0380f`. RDD: assessed `high` (process_boundary, gate-bash.ts),
  consent `granted` by the coordinator, 4-lens review `approved`, lineage
  `review-e7b4978dafc3742f` acknowledged (authority burned). The findings were
  advisory only.

### T1 follow-up (advisory review findings acted on)
- R4/R3 (WARNING): the first matcher tried every token after stripping quotes,
  so `git commit -m "use git restore x"` would have been hard-DENIED. Rewritten
  to read the line like a shell: quote-aware splitting and tokenizing, and `git`
  counted only in command position (segment start, after `sudo`/`env`/`xargs`
  and similar wrappers, inside `sh -c`/`eval`, inside `$(...)`/backticks).
- R3 (WARNING): `/usr/bin/git` is now recognised. R1: `git checkout <ref> <path>`
  (two positionals, no `-b`/`-B`/`--orphan`) is now caught. A single-positional
  directory (`git checkout src/`) stays uncaught with the bare-name case.
- R2 (WARNING): one tokenizer for the deny matcher and the family. The docs
  now say "nine switches" and note that `denyResetClean` guards two entries.
  The shared reason key is explained in a comment.
- RED (observed): 9 failures in `git_discard.test.ts`, covering 4 new discard
  forms, 4 mentions and the tokenizer case. GREEN: `npm test` -> 722/722. The
  gate-level commit-message case was added after the fix, as a regression pin;
  no RED was observed for it.

### T2 -- seed changes (for the person to review before merge)
Route: inline (one data file + its test + two comments). How the seed is used
(src/core/decisions.ts:118-141, 221-259, 598-620): Jev is handed every rule
verbatim and asked which one "speaks directly to" the action. In the gate only
`prohibits`/`requires_human` take effect (they turn an allow into an ask);
`permits` falls through to the risk rule. So a vague prohibit costs prompts, and
a vague permit is only dangerous in destination decisions. New rows name
the exact forms and carve out the harmless neighbours.

Changed (same id, same intent, so each shows as `differing` in "Import
baseline policies" and the person chooses):
- `read_and_test` (permits): "cleaning build artifacts" became "deleting build
  output", and a sentence now excludes source files and points to
  `discard_uncommitted_work`. "Cleaning" read close to `git clean`.
- `never_write_to_main` (prohibits): adds `master`, matching the branches the
  gate already treats as protected (`rule.pushProtected`: main/master/production).
  Scope widened within the same intent; not flipped.
- `unit_commits` (permits): a push is fine only as a normal push, never a force
  push. The gate denies force pushes by default (`denyForcePush`), so the old
  text permitted something the gate refuses.

Added:
- `discard_uncommitted_work` (prohibits): the T1 forms (checkout -- / . /
  <ref> <path> / -f, restore without --staged, reset --hard, clean -f). It
  explicitly allows `restore --staged`, `checkout <branch>` and `git switch`, so
  it does not pull branch switches into a prompt.
- `no_force_push` (prohibits): covers `--force`, `--force-with-lease` and `-f` on
  any branch. The gate has a deny rule for this, but the seed said nothing.
- `infrastructure_changes` (requires_human): covers terraform/tofu apply and
  destroy and kubectl delete/drain, the other gate deny rules the seed didn't
  cover. It carves out `plan` and read-only kubectl.

Reviewed, unchanged: `own_branch`, `no_ai_attribution`, `own_pr_green`,
`others_pr`, `large_pr`, `dependabot`, `client_always_asks`, `active_uat`,
`cutover`, `production_data`, `production`, `friday`, `ticket_first`,
`model_by_difficulty`, `delegate_by_scope`, `no_inventing_contracts`,
`visual_evidence`. None was wrong against current code. No `prohibits` row was
deleted or flipped.

Not added: `curl | bash`. The deny rule covers it, and a policy row gives Jev
nothing to weigh beyond the rule itself.

Counts: 20 -> 23 rows. prohibits 8 -> 10, permits 9, requires_human 3 -> 4.
The count test and the "eight prohibits" / "twenty" comments were updated to
match.
- RED (observed): 2 failures in `policy_seed.test.ts` (no discard row; counts).
  GREEN: `npm test` -> 723/723.
- Screenshot fixture note: `scripts/screenshot-panels.mjs` `seeds` scenario
  still hard-codes `skipped: 20`. That gets fixed in T2b, which re-renders the
  panel.

### T2b -- baseline version notice
- Route: delegated (one writer). Trigger: the change touches 5+ non-trivial
  files (core, main.mjs, config.html, two harnesses, tests). The parent pinned
  the design, then reviewed, corrected and verified the result.
- Seed: `{ "version": 1, "policies": [...] }`. `parseSeedPolicies` reads both
  shapes. `parseSeedVersion` returns 0 for a bare array or malformed input. A
  test pins a digest of `policies` next to `version`, so editing a row without
  bumping the version fails.
- Core (pure): `src/core/policy_seed_notice.ts` has `parseOfferedVersion` and
  `decidePolicySeedNotice`, built on `mergePolicySeeds`. `due` only when the
  shipped version is newer AND added + differing > 0.
- Storage (main.mjs): `policySeedOfferedVersion` `{version, at}` is written on
  fresh seeding, on any successful import, on dismiss, and when a bump has
  nothing for this install. `policySeedNoticeStatus`
  `{due, added, differing, shippedVersion, at}` is published at activation,
  after import or dismiss, and on the poll tick when it changes. Dismiss is
  its own pair, `policySeedDismissRequest`/`Result`, with the same TTL pattern.
  An install that declined first-run seeding (it already had policies) is NOT
  marked offered, so it gets the notice.
- Panel: the notice appears only when status is due with non-zero counts. "Review
  the changes" runs the existing import/choose flow with no accepted ids; the
  notice never writes `policies`. "Dismiss" marks the version as offered. A
  panels spec asserts every `policies.*` key exists in both ES and EN.
  `denyTier.resetCleanHint` now says "uncommitted changes and untracked files".
- Parent corrections after review: the notice's buttons sat flush against
  the policy list, so it now has a 14px bottom margin. The `seeds` screenshot
  fixture showed "21 added" beside a 2-row list, a state the app cannot
  produce; its install now holds every shipped row with two edited, so the
  real merge reports 0 added / 2 differing.
- TDD: core and main.mjs got tests first, with RED observed by the writer
  (reported: bare-array seed -> 2 failures; missing module; 12 main.mjs
  assertions). Panel HTML was written BEFORE its Playwright specs (writer-
  reported deviation from strict order). The specs do run and pass against
  the real page.
- Checks: `npm test` -> 748/748; `npm run test:panels` -> 11/11;
  `npm run shots` -> 80 screenshots, no horizontal overflow, no script errors.
- Screenshots read by the parent: `baseline-config` Team policies area at
  1440/768/390/320 in light and dark (all 8), plus the full page at 1440 light.
  `seeds-config`: full page at 390 dark; the choose-flow area at 320 light,
  768 light and 1440 dark. Not read: `board.html` shots (the board did not
  change), and the `fresh`/`ready`/`degraded` config shots, which differ only
  in the seed text of the first rows and in `resetCleanHint`. That hint was
  read in the baseline 1440 full page.

## Next step
Combined RDD review of fd0380f..HEAD, then push and PR.
