# Release 0.6.24: refuse a discard only when something would be lost; `gh pr update-branch` is not a write to main

## Objective
- **JEVADV-100.** The discard rule refuses `git reset --hard`, `git clean -f`, `git checkout -- <path>` / `.` / `-f` and `git restore` from their spelling alone, even on a clean tree.
- **JEVADV-103.** `gh pr update-branch` is refused by the owner's `never_write_to_main` policy, although it writes only the pull request's own branch.

The owner asked on 2026-10-02: "Podemos afinar esos comandos de git que realmente no son destructivos?" and "Es posible validar si hay cambios pendientes o algo asi". They are tired of running `gh pr update-branch` by hand.

## Baseline (measured before any change)
`gh pr update-branch 821` fed to the installed hook in the client frontend checkout, 5 runs, each with an empty temporary cache (`ORCA_SUPERVISOR_CACHE_DIR`): **5 of 5 deny, from Jev, by policy `never_write_to_main`**. The probe is `scratchpad/0624/probe-update-branch.mjs`; nothing is executed.

## Scope
- **T1 Discard judged on actual loss (writer, branch `0624-discard-loss`).** When the discard rule matches, the gate runs one bounded local git call in the directory the command acts on. It refuses only when that call shows something would be lost now.

  | Subcommand | What is lost | Check |
  |---|---|---|
  | `reset --hard` | staged and unstaged changes to tracked files (untracked files survive) | `status --porcelain`: any line that is not `??` or `!!` |
  | `clean -f [-d] [-x/-X] [paths]` | untracked files, gone for good | the same arguments with `-n` instead of `-f` (dry run): any output |
  | `checkout -- <paths>`, `restore <paths>` | worktree changes under those paths | `status --porcelain -- <paths>`: worktree column |
  | `checkout .`, `checkout -f`, `restore .` | worktree changes in the whole tree | `status --porcelain`: worktree column |
  | `restore --staged --worktree` | both columns | both |

  - The directory: the hook `cwd`, a leading `cd X &&` (the per-segment cwd `command_locations.ts` already gives), and git's `-C`.
  - **Fail closed, to today's deny:** a match inside `ssh`, `eval`, `bash -c` or `$(…)`; `--git-dir`, `--work-tree` or `HOME=` in the command; an unresolvable directory; not a repository; a git error; or a timeout (the existing `GIT_TIMEOUT_MS` / `gitOutput`).
  - **Nothing would be lost:** the rule's outcome is null and the command takes the ordinary Jev path. Never a local allow. `reset --hard <other-ref>` that leaves commits behind is Jev's call; the reflog keeps them.
  - When the rule does refuse, the reason names what would be lost: a count and one example path.
  - A bare `git checkout <branch>` is already not matched (see `git_discard.ts`) and stays that way.
- **T1b Regenerated files are no loss (writer, same branch, after T1).** The owner's real case: `git restore apps/web/CLAUDE.md apps/web/next-env.d.ts` in a worktree where the real change was already committed and a Next dev server had rewritten the two files. T1 alone still refuses it, because those files are modified. Five agents were stopped by the same refusal in one day, and the owner does not want to switch the rule off or type the command by hand.
  - **Built-in regenerated set** (`src/core/regenerated_files.ts`): `next-env.d.ts`, `*.tsbuildinfo`, `.next/`, tracked or not. For untracked files only (what `git clean -n` lists), also the build and temp folders `git_recoverability.ts` trusts (`dist`, `build`, `node_modules`, ...). A tracked change under `src/build/` or `tmp/` is source and still refused. A secret-shaped path is never regenerable, whoever lists it, and a directory the dry run collapses into one line (`Would remove dist/`) is searched with one bounded `git ls-files -o` for secret-shaped files before it is excused.
  - **Per-repository list: out of scope for 0.6.24.** It would be a new setting (panel, mirror, screenshots). The work is kept in a named git stash (`0624: per-repository regenerated list, out of scope`) for a later release.
  - **The refusal names only the real work** and gives the agent a way forward instead of "ask the person": a `git stash push [-u|-a] -m 'jev-discard-<tag>' -- '<exact paths>'` to run as its own command, then retry. A stash chained to the discard on one line stays refused (the tree is read before the line runs). `git stash push` itself is not matched by the discard rule.
  - **Unchanged:** `restore --staged`, branch switches, force push and every other NEVER_SILENTLY rule.
  - **Measured with the real Jev** (real key and policies, empty cache, 5 runs each, throwaway repository): `git restore` of the two regenerated files with the list set: 5 of 5 allow (measured before the list was dropped; re-measured by the lead with `next-env.d.ts` alone on a feature branch: 5 of 5 allow, against a local-rule refusal on 0.6.23); the suggested `git stash push`: 5 of 5 allow. No local fact for Jev is needed. Baseline for the same restore before T1b: refused by the local rule.
  - **`git checkout --detach <branch>` with a dirty `.atl/`** (the other case in the report) is not matched by the discard rule in 0.6.23 either (probed on a throwaway repository, clean and dirty): the refusal that session saw came from another layer and is not reproduced here. Left open until the exact command and the gate record are available.
- **T2 A local fact for `gh pr update-branch` (lead, after T1).**
  - A static, no-network description, fed into the same Jev state the policy and risk questions read, exactly like `detectDeployPublish` / `deployPublishSignal`: it merges the pull request's base branch into the PR's own head branch, and writes only the PR branch.
  - No `gh pr view` and no network call.
  - Bump `GATE_DECISION_RULES_VERSION`, so cached verdicts of the old wording (the shape cache keeps them up to 30 days) are judged again.
  - Measure: the same probe, 5 runs after the change. If the fact does not move the verdict reliably, say so; the remaining lever is the policy wording, not a local override.
- **T3** README, CHANGELOG, version, QA in `odd/qa/qa-0.6.24.md`, release, live check.

## Expected replay delta
- Expected before the change: 0 flips. That was wrong: the H-discard rows run in a directory whose only changes are 3 untracked files, which I had counted as dirty.
- **Measured:** 5 rows now go to Jev instead of being refused, all of them correctly. `checkout .`, `restore .`, `reset --hard`, `env A=1 git reset --hard` and `checkout -- src/a.ts` leave untracked files alone, so nothing would be lost.
- **Still refused:** `clean -fd`, which deletes untracked files; the `/tmp` and `-C /tmp` rows (not a repository); `bash -c "git clean -fdx"`; and D10.
- Replay-0615 passes 244/244 and the other five sets are unchanged.
- New replay rows: a clean repo for each table row, which go to Jev; a dirty one, which is refused; and `gh pr update-branch`.

## Checklist
- [x] T1 discard judged on actual loss (branch `0624-discard-loss`; 36 gate tests, 30 unit tests green)
- [x] T1b regenerated files are no loss (built-in set), stash way forward (same branch)
- [x] T2 update-branch fact and rules version (35bd9eb: RED at import, then GREEN 3/3; probe 5/5 deny before, 5/5 allow after)
- [ ] T3 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD for each behaviour change (RED observed, then GREEN).
- `npm run typecheck` exits 0 and `npm test` is green.
- Replay sets: only the expected delta moves.
- The privacy test exits 0.
- Probe after T1b: the owner's `git restore` of a regenerated file is allowed by the rule and by the real Jev (5 of 5), and the stash it suggests is allowed too.
- Probe after T2: the verdict on `gh pr update-branch 821` recorded against the 5/5 baseline.
