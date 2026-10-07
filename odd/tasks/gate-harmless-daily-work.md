# Release 0.6.28 (part 2): the gate stops only what can really affect something

## Objective
The owner, 2026-10-07:
- "quiero una solucion para que esto funcione y que atrape comandos que realmente van a afectar algo no los de uso diario de los proyectos que hago";
- "Esto te lo he pedido varias veces y lo mismo siempre nueva version y lo mismo";
- "Y esto no para" — `git add` on `feat/cin-1236-link-previews` (a working branch) was refused under `never_write_to_main`.

This release also carries the unreleased remembered delivery authorizations (`odd/tasks/remembered-gate-authorizations.md`), whose T5 never ran: the owner stayed on 0.6.27.

## Measured (real transcripts, 3 days to 2026-10-07; corpus kept in the session scratchpad, never in the repo)
835 advice blocks:

| Class | Blocks |
|---|---|
| `rm -rf` and writes inside Claude's scratchpad, `/tmp` and `$TMPDIR` | 349 |
| `wa-send`/`wa-scope` (owner's own tool) | 151 |
| `gh pr merge`, releases and workflow runs | 113 |
| Edits through an interpreter heredoc | 56 |
| Worktree and branch cleanup | 42 |
| `git -C <dir> push origin <own branch>` | ~40 |

Gate log, Oct 5-7: 200-300 advice blocks a day (about 9% of commands) and about 20 denials a day. Denials from Jev under `never_write_to_main` include read-only `graft skeleton` and `git add` on working branches.

## Design
Deterministic layers decide before Jev, so Jev's noise cannot reach harmless work. Every layer fails closed.
1. **Branch-scoped policy.** A new policy scope, `protected-branch`, for the seed `never_write_to_main`. It is judged only when the command can reach a protected branch (main, master, develop, plus push_remote's list):
   - the branch it acts on, in any target or acting directory, is protected, or is unknown or detached;
   - or the command text names a protected branch.
   On a working branch the policy is never asked. A push to a protected branch is still refused by the local rule.
2. **Contained effect.** A command whose every segment is either obviously safe or writes or deletes only inside a temp root is allowed locally:
   - temp roots come from the environment: `os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, `/var/folders`, and the Claude tmp root taken from the session's scratchpad or `CLAUDE_CODE_TMPDIR`. None is hardcoded per machine;
   - literal `VAR=value` assignments made earlier in the same command are expanded;
   - it fails closed on an unresolved variable, `$(...)`, a `..` escape, or a symlink that leaves the root (realpath of the deepest existing parent);
   - `>`, `>>` and `tee` into a temp root count as contained;
   - an interpreter fed code (`python3 -`, `node -e`, heredoc to an interpreter) never counts.
3. **Wider read-only.**
   - Add `set -e/-u/-o pipefail`, `sleep`, `true`, `test`/`[`, `printf`, `sort`, `uniq`, `diff`, `du`, `df`, and `mkdir -p`;
   - add `git -C <dir>` with a read-only verb;
   - add graft's read subcommands (`ask`, `grep`, `skeleton`, `callers`, `map`).
   - A command that writes nothing never reaches policy coverage.
4. **`git -C <dir> push` of an own branch.** It qualifies like `cd <dir> && git push`. The destination comes from the explicit refspec, checked against the protected list, and the branch upstream does not matter.

## Out of scope
- `wa-send`/`wa-scope`: they are owner-specific. In a public plugin they need configuration (remembered authorizations or a working `permits` policy).
- `ssh`/`scp` and interpreter heredocs stay with Jev.

## Checklist
- [ ] T1 `protected-branch` policy scope; seed `never_write_to_main` uses it; hook passes the resolved branches
- [ ] T2 contained-effect layer (temp roots, assignment expansion, fail-closed)
- [ ] T3 wider read-only segments
- [ ] T4 `git -C <dir> push` own branch
- [ ] T5 replay (corpus before/after per class plus a must-stop set), remembered-authorizations T5 replay, docs, version 0.6.28, release, catalog, live check

## Acceptance criteria
- Strict TDD: RED observed, then GREEN, per task. `npm run typecheck` 0, `npm test` green, `npm run test:panels` green.
- `git add`/`git commit` on a working branch never reach `never_write_to_main`; on `main` they still do.
- `rm -rf <scratchpad>/x`, `S=<scratchpad>; rm -rf $S/x && mkdir -p $S/x` are allowed without Jev.
- Must-stop set, where nothing is newly allowed:
  - force push; push to main;
  - `rm -rf ~`; `rm -rf` of the repo; `rm -rf /tmp/../Users/x`; `rm -rf $UNSET/x`;
  - a symlink in tmp that points at home;
  - `> ~/.zshrc`; `gh release create`.
- Replay: the scratchpad class falls to near zero, and the must-stop set stays at zero.

## Checks
`npm run typecheck`, `npm test`, `npm run test:panels`, `npm run shots`, the replay script (scratchpad).
