# QA 0.6.28: the gate stops only what can really affect something

Run on 2026-10-07 against `fix/gate-harmless-daily-work`. That branch carries the unreleased remembered delivery authorizations (`odd/tasks/remembered-gate-authorizations.md`) together with `odd/tasks/gate-harmless-daily-work.md`.

## Why

The owner, 2026-10-07: "quiero una solucion para que esto funcione y que atrape comandos que realmente van a afectar algo no los de uso diario de los proyectos que hago", and "Esto te lo he pedido varias veces y lo mismo siempre nueva version y lo mismo". During this run, an agent in another project was refused `git add` on a feature branch in a client project under `never_write_to_main`.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | see scenario 1 |
| `npm run test:panels` (after T7) | 207/207 |
| Rules tab shots, 1440/768/390/320, light and dark, ready and fresh | 16 read; no overflow (`screens-0.6.28/`) |
| Offline replay, 834 real advised commands | 135 no longer advised (was 0): 54 skip Jev, 57 skip the risk score, 24 after one confirmation |
| Must-stop set, 31 commands | 31/31 still stopped |

## Scenarios

| # | Scenario | Command or evidence | Expected | Observed | Result |
|---|---|---|---|---|---|
| 1 | Full suite after docs and version | `npm run typecheck && npm test` | 0 errors, all pass | typecheck exit 0; tests 3554, pass 3554, fail 0 | PASS |
| 2 | `git add` on a working branch never asks `never_write_to_main` | hook subprocess test (T1, 2c6305d) | Policy not offered on `feat/x`, offered on `main` | RED 2 of 5, GREEN 5/5 | PASS |
| 3 | A git segment that also writes a file keeps the policy on main | `git branch -d x 2>/dev/null` on main (8008e2e) | Policy kept | RED, then GREEN | PASS |
| 4 | Scratchpad work skips Jev | `S=<tmp>/x; rm -rf $S && mkdir -p $S && cd $S && git init -q` (T2) | `contained` allow | GREEN 22/22 unit, 2 of 4 hook RED, then GREEN | PASS |
| 5 | zsh expansions fail closed | `$S:h:h`, `"$S[1]"`, `=git`, `>!`, relative `cd` (85b2a9e) | Not contained | RED 2 of 21, then GREEN | PASS |
| 6 | Own-tree work on a working branch | `sed -i '' 's/v1/v2/' package.json && git add package.json && git commit -qm x` on `feat/x` (T6) | `own-tree`; Jev asked only for policy coverage | GREEN 413/413 and 4/4 | PASS |
| 7 | `git -C <dir> push origin feat/x 2>&1 \| tail -3` | push_own_branch unit and hook (T4) | Local git allow | RED 1 of 104, then GREEN | PASS |
| 8 | Trusted program with a planted twin | `ln -s /bin/sh /tmp/x/acme-notify && /tmp/x/acme-notify -c '…'` (0cc4765) | Not trusted | RED 4 of 14, then GREEN 51/51 | PASS |
| 9 | `$(cat /dev/zero)` in a trusted line | fbc9e50 | Returns promptly, not trusted | Hung past 20 s before, prompt after | PASS |
| 10 | Panel: add, remove, refused name with reason | `panels.spec.mjs` (723f66c) | All three behave | 8 of 8 RED, then GREEN | PASS |
| 11 | Offline replay of real advice | see below | Many harmless classes pass, must-stop set stays at zero | 135 / 834; 31 / 31 stopped | PASS |
| 12 | Live: marketplace install at 0.6.28; a scratchpad `rm -rf` and a `git add` on a working branch pass without advice; the log shows `contained` / `own-tree` | Orca → Check for update, then real commands; `gate-decisions-*.jsonl` | Lock 0.6.28; rows with the new stop reasons | filled in at the live check | |

## Offline replay

The corpus is the owner's advice blocks from three days, taken from transcripts. It stays in the session scratchpad and never enters the repository, because it contains private data. The replay calls the pure layers only (`isObviouslySafeCommand`, `isContainedToTempRoots`, `isOwnTreeWork`, `qualifiesForLocalGitAllow`, `deliveryClassesOf`, `isTrustedProgramLine`) and never Jev. A delivery line counts as passing when its classes are remembered, which happens after one confirmation in that repository. The trusted list is `wa-send`, `wa-scope`. Linked worktrees are detected with a real `.git`-file check on paths that still exist. Worktrees from those days are gone, so their branches are simulated: a suffixed directory such as `repo-xxx` was on a working branch, and the main checkout was on main.

| Class (regex over the text) | Passed / advised | Layer |
|---|---|---|
| Mentions a scratchpad or `/tmp` | 57 / 349 | contained 54, delivery 2, trusted 1 |
| `wa-send` / `wa-scope` | 43 / 151 | trusted 43 |
| `gh` delivery | 22 / 113 | delivery (once remembered) |
| Other | 13 / 64 | local git 11, own tree 2 |
| Interpreter heredoc, `sed -i` | 0 / 56 | stays with Jev |
| Worktree and branch cleanup | 0 / 42 | stays with Jev |
| `git push` (plain) | 0 / 30 | stays with Jev |
| `ssh` / `scp` | 0 / 29 | stays with Jev |
| **All** | **135 / 834** | |

Not every one of the 135 skips Jev:
- 54 `contained` skip it entirely;
- 57 (`trusted`, `own-tree`, `local-git`) skip the risk score, but where a command-scoped policy applies, each new command shape costs one policy-coverage call, which is then cached;
- 24 delivery lines pass only after one confirmation per repository.

The replay runs from `~/Projects`. Run from the plugin's workspace, which is where the owner's notify and triage lines really run (`WA="$(cat .wa-bin)"`), 66 of the 148 lines that run the trusted programs pass, up from 44. Most of the rest name plugin content-hash directories that are no longer on disk, and those fail closed.

Reading the remaining 699 by hand (a sample of 60, plus targeted samples):
- **Most have a real outward effect,** so stopping them is the correct call:
  - releases that write notes to the scratchpad and then run `gh release create`;
  - messages to people other than the owner;
  - `ssh` into servers;
  - `infisical` against staging;
  - Jira comments, `curl -X PUT` and `git reset --hard`.
- **Interpreter code (`python3 - <<EOF`) stays with Jev.** It is opaque, and it may write anywhere.
- **Not covered here:** writes to `~/.cache/...` (outside the repository and the temp roots), `rm` with a glob, `git rm`, and `git worktree remove --force` together with `git branch -D`.
- `OWNER="$("$WA/wa-scope" owner)"` and a relative `$(cat .wa-bin)` were gaps found by this replay. Both are fixed: 8db59c6 and dad6ed8.

Must-stop set: none passes.
- force push, `-f`;
- push to `main` and `HEAD:main`;
- `git -C /p push origin main`, and `+feat/x`;
- `rm -rf ~`, `rm -rf $HOME`;
- `rm -rf` of a repository;
- `rm -rf /tmp/../Users/x`, `rm -rf <scratch>/../../Users/x`;
- `rm -rf $UNSET/x`, `rm -rf /tmp`, `rm -rf <scratch root>`;
- `> ~/.zshrc`, `>> ~/.zshrc`;
- `cp ~/.ssh/id_rsa <scratch>/x`;
- interpreter code, from a heredoc or `-c`;
- `gh release create` and `gh pr merge --admin` (not remembered);
- an untrusted program in a `$(…)` handed to a trusted one, and a trusted value handed to `curl`;
- `git reset --hard`;
- `IFS=/`, `PATH=` prefix, `$(…)`, `$S:h:h`;
- a planted `wa-send` symlink to `/bin/sh`;
- a secret passed as an argument;
- `wa-send x && ssh host rm -rf /`.

## Findings

1. The hook has no Jev stub, so the Option-D-style policy path for `own-tree` and `trusted` lines is covered by unit tests and typecheck, not by a hook subprocess test.
2. A trusted program found through PATH resolves on the hook's own PATH, which can differ from the Bash tool's profile PATH. When it cannot be found, the line fails closed.
3. The live hook receives `CLAUDE_CODE_TMPDIR` from the owner's `~/.zshrc` through the Claude process. This is confirmed on the parent process, and scenario 12 confirms it from the gate log.
