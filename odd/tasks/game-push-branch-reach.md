# `orca game push` on main is not a write on main

## Objective
On 2026-11-03 (gate log `gate-decisions-2026-11-03T03.jsonl`, a client project, `commandFamily: orca`, `source: jev`, `verdict: deny`, `policyId: never_write_to_main`), an Orca lead whose checkout was on main ran `/Applications/Orca.app/Contents/Resources/bin/orca game push` and was refused. `orca game push` sends the continue prompt to member terminals and writes no file in the checkout.

## Cause
The bug report suspected a match on the word "push". The code does not do that:
- `pushTargets` (`src/core/deny_rule_shapes.ts`) reads only git pushes (`pushInvocations`), and finds none in `orca game push`.
- `namesProtectedBranch` finds no protected branch name in it.
- `branchReachPlaces` (`src/core/branch_reach.ts`) counted the session's directory, because `orca` is on neither of its two lists (programs that write no file, programs that write only the files they name). On a main checkout that keeps never_write_to_main, so Jev was asked, and Jev refused.

## Scope
- **G1 (core):** `branch_reach.ts` reads `orca game` commands that write no file in the checkout as writing nothing but their redirect targets: `push`, `state`, `leads`, `accounts`, `member`, `history`, `metrics`, `events`, `owner-questions`. The program is `orca` or `orca-ide`, by bare name or an absolute path outside the checkout. Every word must read as written.
- Not included, so they still count their directory: `scene new` (writes a scene file), `launch` and `wave` (create worktrees), `view` (stores settings), `sweep --close`, every other `orca` command group, an `orca` inside the checkout (`./orca`), and an unreadable word (`orca game "$SUB"`).
- **Not changed:** `npm run push-docs` on main still counts its directory. An npm script may write the checkout or push main, and `npm install` counting its directory is an existing case (`branch_reach.test.ts`, B1). The policy is asked there, and the verdict is Jev's.
- `echo push` already wrote nothing (tier 1a); it is pinned as a regression case.

## Checklist
- [x] G1 RED: `branchReachPlaces` returned `["/work/repo"]` for the refused command; the gate-bash integration test judged it `with-policy` on main.
- [x] G1 GREEN: both return no place / `without-policy`; true positives (`scene new`, `npm run push-docs`, `git commit`, `orca game push && git commit`, `git push origin main`) still keep the policy.
- [x] Release 0.13.14 (#116): CHANGELOG, README, `package.json`, `orca-plugin.json`.

## Acceptance criteria
- The refused command on a main checkout is not judged against never_write_to_main.
- Every existing true positive still keeps it.
- No UI changes, so no screenshots.

## Checks
`npm run typecheck`, `npm test`.
