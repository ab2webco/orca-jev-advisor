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
- [ ] **T2** Refresh `seed/policies.json`. Route: inline (one data file).
  Checks: `src/core/policy_seed*.test.ts` green.
- [ ] **T3** Append "Plan review findings (2026-09-24)" to odd/CHECKPOINT.md.
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

## Next step
T2.
