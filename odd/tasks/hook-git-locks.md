# The hook never leaves a git index.lock behind

## Objective

The git commands the gate hook runs to read a checkout never take that checkout's index lock, and never leave one behind when they are stopped.

## Why

On 2026-10-18 the orca-oss lead reported a 0-byte `index.lock` in the orca-611 worktree, three times in one session, with no process holding it. Each one blocked the next unchanged retry of a git command that Jev had advised against.

**Cause.** `gitOutput` (`adapters/claude/gate-bash.ts`) runs `git status`, which refreshes the index and takes the optional index lock to do so. It stops a git that runs past `GIT_TIMEOUT_MS` (1.5 s) with SIGKILL, and git cannot remove its lock after SIGKILL. In orca-611, `git status --porcelain --ignored -uall` takes 1.81 s.

## Scope

- Every hook git call runs with `GIT_OPTIONAL_LOCKS=0`.
- An overrunning call gets SIGTERM, on which git removes its own lock files. `git add --dry-run` still takes the lock.
- Unchanged: the timeout, and what each call reads.

## Checklist

- [x] L1 The hook never writes or locks the index (RED: with a stale index entry, the hook's `git status` rewrote `.git/index`)
  - Proof: `adapters/claude/gate-bash.test.mjs` L1 failed before the change ("the index is unchanged, so git never took its lock") and passes after it.
- [ ] L2 Release 0.13.6: CHANGELOG, README block, version bump, release, catalog, `odd/qa/qa-0.13.6.md`

## Acceptance

- No hook git call leaves `index.lock` behind, whether it finishes or overruns.
- `npm test` and `npm run typecheck` pass.
