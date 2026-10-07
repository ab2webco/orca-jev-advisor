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
- [x] T1 `protected-branch` policy scope; seed `never_write_to_main` uses it (seed version 5); hook passes the resolved branches. Commit 2c6305d. `filterPoliciesForBranchReach` (decisions.ts) keeps the policy when any branch the command writes on (acting_location.ts places after `cd`/`git -C`/a write target, plus every push destination, implicit ones included) is protected (client_reach.ts `SHARED_BRANCH_NAMES`: main, master, production, develop, staging), unknown or detached, or the text names one (`branch_reach.ts`: whole word, refspec side, `origin/main`; any non-safe `gh` counts). A place outside any repository has no branch and drops out. RED: 3 unit (2 files on missing exports, the seed scope) and 2 of 5 subprocess (`git add` and `git branch -d` on `feat/x`); GREEN: 238/238 unit across decisions, policy_seed, branch_reach, client_reach, acting_location, seed import, fingerprint; 5/5 subprocess; gate-bash.test.mjs and main.test.mjs 489/489. Typecheck 0.
- [x] T2 contained-effect layer (temp roots, assignment expansion, fail-closed). Commit 3c22004. `src/core/contained_effect.ts`: its own quote-aware reader (the shared tokenizers drop the quoting that decides `$VAR`), segments followed through `&&`/`||`/`;` as the shell runs them, standalone and `export` assignments expanded per branch; writers `rm` (final `*` only, in a temp directory), `mkdir`, `touch`, `cp`/`mv` (sources and destination inside), `ln -s` (link inside), `cat`/`echo`/`printf`/`tee` with `>`/`>>`, `git init`; everything else must be obviously safe. Roots from `tempRootsFromEnvironment`: `os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, `/var/folders`, `$CLAUDE_CODE_TMPDIR/claude-<uid>` (the PreToolUse input carries no scratchpad path); a root that holds home is dropped. Never contained: a root itself or an ancestor of one, home/cwd/the session repository or anything holding them, a linked worktree, a path under a symlink/copy/move made earlier in the command, a heredoc to anything but `cat`/`tee`, an unquoted heredoc body with `$` or backticks, an assignment to a name that steers the shell (`IFS`, `PATH`, `HOME`, `GIT_*`, ...), a prefix assignment, a background `&`, a subshell. Hook: after the local deny rules, before policies, cache and Jev; allow with stopReason `contained` (source `local-rule`), reason es/en. RED: 5 of 17 unit against a stub, 1 measurement round-trip, 2 of 4 subprocess; the IFS/PATH/`git status` cases were found by a probe of 30 extra shapes (2 mismatches) and added as tests with the fix. GREEN: 22/22 contained_effect + privacy, 42/42 measurement, 327/327 gate-bash.test.mjs. Typecheck 0.
- [x] T3 wider read-only segments. Commit d1aa63f. Tier 1a now also passes `set -e/-u/-x/-o pipefail` (and clusters), `sleep N`, `true`, `false`, `test`/`[ ... ]`, `printf`, `diff`, `du`, `df`, `basename`, `dirname`, `realpath`, `stat`, `tr`, `cut`; `sort` without `-o`/`--output`/`--compress-program` (also folded, `-uo`); `uniq` with at most one operand; `file` without `-C`; `git -C <dir> <verb>` with the same read-only verbs as plain git, one `-C` and no other global option (`-c`, `--git-dir`, `--work-tree` stay out); `graft ask|grep|skeleton|callers|map` only. Redirections still fail a segment. `mkdir -p` stays out of tier 1a (it writes): T2 covers it inside temp roots, against the design list above. RED: 4 of 43; GREEN: 43/43, and 735/735 across the safe list's dependents (client_reach, delivery_class, gate_advice_text, push_own_branch, acting_location, branch_reach, contained_effect, command_locations, gate_measurement, gate-bash.test.mjs). Typecheck 0.
- [x] T4 `git -C <dir> push` own branch. Commit 7c83bfb. `classifyDashCPushSegment` (push_own_branch.ts): one `-C` with a plain directory, no other global option, the plain push options, a bare remote and an explicit non-`HEAD` plain refspec that is not protected; an omitted or `HEAD` refspec, `+ref`, `:ref`, `HEAD:main`, `--force*`, `--delete`, `-c`, `--git-dir`, `--work-tree`, a second `-C` or a `$DIR` never qualify. The exported `parsePushSegment` is unchanged, since client_reach.ts reads it with the session's remotes; its doc now says why. With T1, the branch policy is read at the `-C` directory: from a session on main, `git -C <feature checkout> push origin feat/x` is allowed locally. RED: 1 of 104 unit (the positives), 1 of 2 subprocess (observed by removing the change); GREEN: 104/104 unit, 568/568 across push_own_branch, client_reach, delivery_class and gate-bash.test.mjs. Typecheck 0.
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
