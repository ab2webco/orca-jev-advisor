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
- **T2 A local fact for `gh pr update-branch` (lead, after T1).**
  - A static, no-network description, fed into the same Jev state the policy and risk questions read, exactly like `detectDeployPublish` / `deployPublishSignal`: it merges the pull request's base branch into the PR's own head branch, and writes only the PR branch.
  - No `gh pr view` and no network call.
  - Bump `GATE_DECISION_RULES_VERSION`, so cached verdicts of the old wording (the shape cache keeps them up to 30 days) are judged again.
  - Measure: the same probe, 5 runs after the change. If the fact does not move the verdict reliably, say so; the remaining lever is the policy wording, not a local override.
- **T3** README, CHANGELOG, version, QA in `odd/qa/qa-0.6.24.md`, release, live check.

## Expected replay delta
- The replay discard cases (D10, the H-discard-* rows) run in directories that are dirty, or not repositories (`/tmp`), or wrapped in `bash -c`. All stay refused, so the expected delta is **0 flips**.
- New replay rows: a clean repo for each table row, which go to Jev; a dirty one, which is refused; and `gh pr update-branch`.

## Checklist
- [ ] T1 discard judged on actual loss
- [ ] T2 update-branch fact and rules version
- [ ] T3 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD for each behaviour change (RED observed, then GREEN).
- `npm run typecheck` exits 0 and `npm test` is green.
- Replay sets: only the expected delta moves.
- The privacy test exits 0.
- Probe after T2: the verdict on `gh pr update-branch 821` recorded against the 5/5 baseline.
