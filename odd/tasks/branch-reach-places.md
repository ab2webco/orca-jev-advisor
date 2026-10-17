# Branch policies follow where a command writes, not where it runs

## Objective

A `protected-branch` policy such as `never_write_to_main` is asked about a command only when that command can write into a checkout that is on a protected branch. Commands that only read, and commands whose writes all land outside the repository, are not asked about it, even when the session sits in a checkout on `main`.

## Why

On 2026-10-17 the owner reported that the gate stops ordinary git-workflow work. In a session on the main checkout, `rm -rf ~/Library/... && ln -s ...` was refused under `never_write_to_main`. That command does not touch the repository.

**Log, 10-16 and 10-17.** There were 18 denies under `never_write_to_main`. The command families were `pgrep`, `head`, `mkdir`, `rm`, `rm -rf`, `python3`, `other`, `git discard` and `git push`. The last three can be real hits; the rest look wrong.

**Cause.** `branchReachPlaces` (`src/core/branch_reach.ts`) counts the directory a segment runs in as a place it writes, unless the program is obviously safe or is one of `rm`, `cp`, `echo` or `printf`. So `pgrep`, `head` in a pipeline, `mkdir`, `ln` and `touch` all count the session's checkout. When that checkout is on `main`, the policy is asked, and Jev answers `violation`.

## Scope

- **Programs that write no files.** These add no place except their redirect targets:
  - `pgrep`, `ps`, `lsof`, `kill` and `pkill`;
  - readers and filters that are not already obviously safe;
  - `find`, only without `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint*` or `-fls`;
  - `sed`, only without `-i` or `--in-place`;
  - `sort`, only without `-o`.

  The list is strict: a program that may write a file it does not name in its arguments stays out of it.
- **Programs whose only writes are files they name.** `mkdir`, `touch`, `ln`, `mv` (sources and destination), `chmod`, `chown` and `tee` count the files they name, as `rm` and `cp` do today. A target that cannot be resolved (`$X`, a glob, a substitution) is an unknown place, as today.
- **Unchanged.** Interpreters, build tools, git, gh and any program not on these lists still count their directory. Unknown places still keep the policy. Nothing changes for checkouts that are not on a protected branch.

## Checklist

- [x] B1 Programs that write no files, and programs that write only what they name, add only the right places (RED: `pgrep -f x` and `rm -rf ~/Library/a && ln -s ~/b ~/Library/a`, run from a checkout on main, still reach it)
  - Proof: `src/core/branch_reach.test.ts` B1 tests, RED 8 of 10 before the change (`pgrep -f x` reached `/work/repo`; `rm -rf ~/Library/a` resolved to `/work/repo/~/Library/a`), GREEN after. `~`, `$HOME` and `${HOME}` now resolve to home for named files and redirect targets; a substitution or brace expansion in a named file is an unknown place; a delete, move, chmod or chown of a directory holding the checkout reaches the checkout.
  - Found on the way, fixed in `gate_safe_command.ts` with RED tests: `find -fls FILE` and `rg --pre CMD` were obviously safe (tier 1a) though one writes a file and the other runs a program.
- [x] B2 Gate level: in a checkout on main, these commands are not asked about `never_write_to_main`. A write inside the checkout (`mkdir src/x`, `mv src/a.ts /tmp/`, `sed -i`, `tee src/x`, `python3 x.py`, `find . -delete`) still is.
  - Proof: `adapters/claude/gate-bash.test.mjs` B2 tests through the real hook and a real repository on `main`. RED with the old `branch_reach.ts`: `pgrep -f x`, `ps aux | grep node` and `rm -rf ~/Library/a && ln -s ~/b ~/Library/a` were judged with never_write_to_main. GREEN after; `mkdir src/x`, `touch src/x`, `mv src/a.ts /tmp/a.ts`, `sed -i`, `tee src/x`, `python3 x.py`, `find . -delete`, `git commit -m x` and `ln -s /tmp/a` still are. On `feat/x` none is. `mkdir -p /tmp/x` was already allowed as contained before the policy stage, before and after.
- [x] B1/B2 verifier follow-up: every blocker the independent verifier found in the first cut is asked again, with a RED test each.
  - sed is a reader only on an allowlist (`-n`, `-E`, `-r`, `--`; one script of line addresses printing or deleting; plain operands): `/s/w`, `-I`, `-l`, `--exp=`, `--in`, `--fi=`, `$FLAG` and `$(echo -i)` keep the directory.
  - A quoted or escaped `~` or `$HOME` is literal (`touch '~/x'` writes the checkout); `"$HOME"/x` is still home.
  - GNU long-option prefixes (`--target`, `--t`) name `--target-directory`; an ambiguous one keeps the directory.
  - An unresolvable operand counts the directory exactly as before (rm and cp keep an unknown place beside the files they name); a process substitution is not a file; `cd -` is an unknown place for branch reach only (the deny and own-file rules keep their home reading).
  - A substitution in the arguments of find, sed, sort, uniq, rg, awk, file or env keeps the directory.
  - Tier 1a (`gate_safe_command.ts`): find, sort, uniq and rg with an expansion or a quoted option, GNU prefixes of `--output`, `--temporary-directory`, `--compress-program` and `--pre`, `sort -T`, `uniq -` or a second operand, and `sed -n $p` / `sed -n 1p $F` are no longer obviously safe; `rg --pretty`, `grep 'foo bar' file`, `find . -name '*.ts'` and `sort -u f` still are.
  - Proof: the verifier's probe files (`probes.txt`, `probes2.txt`, `ml.ts`) re-run: every blocker row asks again; every row that 23d1818 asked and this does not writes only outside the checkout.
- [ ] B3 Release 0.13.5: CHANGELOG, README block, version bump, release, catalog, `odd/qa/qa-0.13.5.md`

## Acceptance

- In a checkout on main, every read-only or outside-the-repo command named above is judged without the `protected-branch` policies.
- Every write that may land in that checkout is still judged with them.
- `npm test`, `npm run test:panels` and `npm run typecheck` pass. An independent verifier finds no write that could reach a protected branch and is no longer asked.
