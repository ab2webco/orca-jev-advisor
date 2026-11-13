# Files git ignores are not a write on main

## Objective
On 2026-11-13 two commands from a session whose checkout was on main were refused under `never_write_to_main` (gate log `gate-decisions-2026-11-13T04.jsonl`, `source: jev`, `verdict: deny`, `policyId: never_write_to_main`):

1. `python3 - <<'EOF' ... open(p,'w') ... EOF` rewriting `odd/tasks/ios-testflight-release.md` (`commandFamily: python3`). `odd/` is listed in `.git/info/exclude`, so the file can never reach main through a commit or a push.
2. `J=<scratchpad clone>` on one line, then `cd $J && sed -i '' ... && scp ... && ssh ...; git -C $J diff --stat` (`commandFamily: sed`). The clone was on `fix/new-03-notification-permission`; the ssh target was a detached-HEAD worktree on another host.

The owner: anything that really writes to main (tracked files, new files git would track, commits, merges, pushes) is still judged; files git ignores or excludes, and anything outside the repository, are not.

## Cause
- `branchReachPlaces` (`src/core/branch_reach.ts`) gives the redirect targets and named files of the programs it reads, and gate-bash.ts resolves the branch of each one. A file place inside a main checkout always counted, ignored or not: `cat > odd/tasks/x.md <<'EOF'` was judged against the policy.
- `buildViolationQuestion` (`src/core/decisions.ts`) told Jev that writing on a branch means "creating, editing, copying, moving or deleting any file there, tracked or new", so Jev was told an ignored file is part of main.
- Refusal 2: the bare assignment `J=...` is on neither branch-reach list, so its directory (the session's main checkout) counted as a write; `cd $J` then made every later place unknown (null), which also keeps the policy. The ssh and the detached HEAD on the other host played no part: the gate only sees local places.
- The file tools (Edit, Write, MultiEdit, NotebookEdit) never judge `never_write_to_main` at all: `gate-files.mjs` only refuses the gate's own files. Nothing changes there.

## Scope
- **T1 (core):** `branchReachWrites` tags each place as a file (a redirect target or a file a listed program names) or a directory (where a program may write anything). A segment of bare `NAME=value` assignments writes only its redirect targets.
- **T2 (gate):** gate-bash.ts asks git, never the command text: a file place on a protected or unknown branch is dropped when `git check-ignore` reports it ignored and `git ls-files` finds no tracked file at or under it. The path is resolved through its symlinks first; a path inside `.git`, the repository root, or a dangling symlink is never dropped. The policy is set aside only when every place left is outside any repository or on a working branch. git runs only when such a file place exists and a protected-branch policy would otherwise be asked.
- **T3 (Jev facts):** when the policy is still asked, the context Jev reads (and the cache key) lists the paths the command names that git verified as ignored. Jev's violation question says ignored files are part of no branch, but only the ones the context lists count, never a claim in the command. `GATE_DECISION_RULES_VERSION` 9 -> 10, so verdicts cached under the old question are judged again.
- **T4 (seed):** seed version 7: `never_write_to_main` states that new files git would track count, and that files git ignores or excludes, and files outside the repository, do not.
- Not included: `sed -i` (GNU and BSD sed read `-i ''` differently, so the written files cannot be known from the text), interpreter code (`python3 -`, `node -e`), and `cd $VAR` after a literal assignment. Those keep asking Jev, now with the verified facts.

## Checklist
- [ ] T1 RED/GREEN: tagged places; bare assignment writes nothing.
- [ ] T2 RED/GREEN: gate-bash integration on real repositories (excluded file allowed; tracked, new non-ignored, mixed, claim-only still judged; feature branch unchanged; detached HEAD).
- [ ] T3 RED/GREEN: violation question wording; facts sentence in the context.
- [ ] T4 RED/GREEN: seed v7 text, digest re-pinned, offered as a differing row.
- [ ] `npm run typecheck`, `npm test`.

## Acceptance criteria
- On main, a shell write whose every target is ignored or excluded is not judged against `never_write_to_main`.
- A write to a tracked file, a new file git would track, a mix of ignored and tracked targets, or a command that only claims a path is ignored, is still judged.
- A working branch is unchanged. Detached HEAD: ignored targets are dropped (they belong to no commit); any other place keeps the policy (fail closed).
- No UI changes, so no screenshots.

## Checks
`npm run typecheck`, `npm test`.
