# Files git ignores are not a write on main

## Objective
On 2026-11-13 two commands from a session whose checkout was on main were refused under `never_write_to_main` (gate log `gate-decisions-2026-11-13T04.jsonl`, `source: jev`, `verdict: deny`, `policyId: never_write_to_main`):

1. `python3 - <<'EOF' ... open(p,'w') ... EOF` rewriting `odd/tasks/ios-testflight-release.md` (`commandFamily: python3`). `odd/` is listed in `.git/info/exclude`, so the file can never reach main through a commit or a push.
2. `J=<scratchpad clone>` on one line, then `cd $J && sed -i '' ... && scp ... && ssh ...; git -C $J diff --stat` (`commandFamily: sed`). The clone was on `fix/new-03-notification-permission`; the ssh target was a detached-HEAD worktree on another host.

The owner: anything that really writes to main (tracked files, new files git would track, commits, merges, pushes) is still judged. Files git ignores or excludes are not, but only when the gate can prove it.

## Cause
- `branchReachPlaces` (`src/core/branch_reach.ts`) gives the redirect targets and named files of the programs it reads, and gate-bash.ts resolves the branch of each one. A file place inside a main checkout always counted, ignored or not: `cat > odd/tasks/x.md <<'EOF'` was judged against the policy.
- `buildViolationQuestion` (`src/core/decisions.ts`) told Jev that writing on a branch means "creating, editing, copying, moving or deleting any file there, tracked or new", so Jev was told an ignored file is part of main.
- The file tools (Edit, Write, MultiEdit, NotebookEdit) never judge `never_write_to_main` at all: `gate-files.mjs` only refuses the gate's own files.

## First design, withdrawn
The first version of PR #121 (head 3925c65) inferred what any shell command writes and dropped every file place git reported ignored. Two blind judges bypassed it. Each of these returned without-policy at 3925c65 and with-policy at base d438834:
- a symlink made in the same command, then a write through it (`ln -s ../src odd/s && printf x > odd/s/a.ts`, `ln -s ../src/a.ts odd/l.ts && ...`);
- hard links (`ln src/a.ts odd/h && ...`, `cp -l`, `cp -al`, an existing hard link to a tracked file);
- a `cd` that fails (`cd odd/missing; printf x > src/a.ts`, also with `|| true`), and `cd -P` through a symlink;
- assignments that change resolution (`PATH=odd:/usr/bin cat ...`, `HOME=$PWD/src; printf x > ~/a.ts`, `CDPATH`);
- an ignore source written in the same command (the global excludes file, `core.excludesFile`);
- an unquoted heredoc whose body runs a command substitution;
- a decoy `GIT_DIR` in the hook's environment;
- the facts sentence resolving the command's words from the acting directory and missing its own later `cd`.

Two more were open at base too: a write inside a submodule, or through a superproject symlink into one. `resolveRepoRootForCwd` returns null there, so the place was read as outside any repository.

## Design: fail closed, allow only the trivially safe case
The policy is set aside only when all of this holds; otherwise it is asked exactly as at base.
- **Trivially safe shape** (`src/core/trivial_write.ts`, pure text): every segment runs `cat`, `echo`, `printf` (no option: `printf -v` assigns), `true`, or a named writer with only its listed options (`tee -a`, `cp -f -p`, `mv -f`, `install -d -m MODE`, `mkdir -p -m MODE`, `touch`), or is only redirections. No `cd`/`pushd`/`popd`/`builtin`, `ln`, `cp -l/-s/-r/-t`, `NAME=value`, `export`, `source`, `.`, `eval`, `exec`, `env`, `command`, substitution, subshell, group, function, comment, glob, brace, `~` or `$` outside single quotes, and no word starting with `=` (zsh's `=name`). Redirections are `>`, `>>`, `>|`, `<`, heredocs, here-strings and fd duplications; `&>`, `<>`, `>&file` and process substitution are not trivial. An unquoted heredoc body holds no `$`, backtick or `\`; a quoted one is data. No target has a `..` or `.git` component. `/dev/null` is not a target.
- **Verified by git and the filesystem** (`src/core/ignored_files.ts`): the payload cwd resolves through `git rev-parse --show-toplevel --show-superproject-working-tree` to one root that is not a submodule. Each target lies inside it; no existing component from the root to it is a symlink (lstat); no directory on the way holds a `.git` (a submodule or a nested repository); an existing file target is a regular file with `nlink === 1`, a directory target a real directory; `mkdir -p` counts every directory it creates. No target is an ignore source: `.gitignore` anywhere, anything in `.git`, the file `.git/info/exclude` resolves to (a symlink there can make a worktree file one), the configured `core.excludesFile`, or the default global excludes file. `git check-ignore` reports each one ignored and `git ls-files` finds nothing tracked at or under it.
- Every git call runs with `gitSubprocessEnv`: no `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX` or `GIT_CONFIG*` from the hook's environment (`GIT_CEILING_DIRECTORIES` stays). Any git failure, unexpected exit or timeout fails closed.
- git runs once per gate call (four calls: rev-parse, config, check-ignore, ls-files), and only when the policy would otherwise be asked.
- **Facts for Jev:** only for a trivially safe command whose verification succeeded and whose policy is still asked (some target ignored, another not). The sentence lists the repository-relative paths git verified, never the command's words. Never for a command with a `cd` or anything else that moves where a path lands.
- **Submodules at base:** a place under a `.git` entry whose root cannot be resolved (`hasGitEntry`, `src/core/linked_worktree.ts`) keeps the policy as an unknown branch, instead of counting as outside any repository.
- **Edit/Write:** unchanged. The file tools never judge `never_write_to_main` (gate-files.mjs guards only the gate's own files), so an Edit or Write of an ignored file already passes, and so does one of a tracked file on main. Making the file tools enforce the policy is a new behavior for the owner to decide.
- `branch_reach.ts` is back to base: a bare `NAME=value` segment counts its directory again.

## Not included (asked as before)
`sed -i`, interpreter code (`python3 -`, `node -e`), refusal 2 (`J=...` then `cd $J`), any write spelled with a variable or `~` (`printf x > $HOME/a.md`), a target outside the repository mixed with ignored ones, `cp -r`, and a destination that already exists as a directory. Those keep asking Jev, with no facts sentence.

## Checklist
- [x] T1 RED at 3925c65: 18 of the bypass tests in `gate-bash.test.mjs` returned without-policy, the cd-facts test too (`I2 bypass (...)`, `I2: a command with a cd gets no facts sentence`); `cd -P odd/s && printf x > a.ts` was not reproduced as written, its `cd -P odd/s/.. && printf x > src/a.ts` variant was. At base d438834 the same tests pass except the two submodule ones. GREEN: all 29 `I2` tests.
- [x] T2 RED: `trivial_write.ts`, `verifyIgnoredTargets`, `gitSubprocessEnv` and `hasGitEntry` missing. GREEN: `trivial_write.test.ts`, `ignored_files.test.ts` (injected git failing, exiting 128, answering garbage, throwing or timing out at each of its four calls fails closed; config unset still allows), `linked_worktree.test.ts`.
- [x] T3 (Jev facts): the violation question says ignored files are part of no branch and only ones the context lists count. `GATE_DECISION_RULES_VERSION` 9 -> 10.
- [x] T4 (seed): seed version 7: `never_write_to_main` states that new files git would track count, and that files git ignores or excludes do not.
- [x] T5 RED at 57744e9 (second review): `printf -v PATH odd:/usr/bin; cat > odd/x.md <<'EOF'` returned without-policy with a planted `odd/cat`; a `.git/info/exclude` symlinked to `odd/exclude-rules` let that file be emptied. GREEN: `I2 bypass (printf -v PATH)`, `trivial_write.test.ts`, `ignored_files.test.ts`.
- [x] Edit/Write pinned: `gate-files.test.mjs`, an Edit or Write of an ignored file on main passes in silence.
- [x] `npm run typecheck` passes; `npm test` passes (see the PR).

## Acceptance criteria
- On main, a trivially safe write whose every target git verifies as ignored and untracked is not judged against `never_write_to_main`: `cat > odd/tasks/x.md <<'EOF'`, `printf x >> odd/notes.md`, `tee odd/a.md`, `cp src/a.ts odd/x`, `mkdir -p odd/dir`.
- Every bypass above, a tracked file, a new file git would track, a mix of ignored and tracked targets, and any command that is not trivially safe are still judged.
- A working branch is unchanged. Detached HEAD: a trivially safe write to ignored files is not judged; anything else keeps the policy.
- No UI changes, so no screenshots.

## Checks
`npm run typecheck`, `npm test`.
