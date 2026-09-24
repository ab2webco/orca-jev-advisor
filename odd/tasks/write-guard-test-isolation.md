# Write-guard: stop tests from reaching the developer's real Claude config

## Objective

A `node --test` run had, for the fourth time, reached the developer's real
files outside the repository: it wiped all four gate hook entries out of
`~/.claude/settings.json` and all four Orca `claude-accounts/*/auth/settings.json`
files, silently, with zero error output. Earlier incidents corrupted
`policies.json` and `catalog.json` twice. Make it structurally impossible
for a test run in this repository to write outside a temp directory,
instead of hunting the one test that happened to trigger it this time.

## Why

`adapters/orca/install-claude-integration.test.mjs` already overrides `HOME`
for every process it spawns directly, so the leak was not "a test forgot to
override HOME" in that one file. The real hole: `adapters/orca/main.mjs`
resolves `HOME_PATHS`/`CONFIG_DIR`/`CLAUDE_HOME_DIR`/`CLAUDE_ACCOUNTS_DIR` as
module-level constants from the real `os.homedir()`/`process.env` at import
time, with no override seam, and its `sidecarEnv()` forwards `process.env`
verbatim (only `NODE_OPTIONS` stripped) to every sidecar it spawns
(`install-claude-integration.mjs`, `write-secret-mirror.mjs`). A test that
imports `main.mjs` in-process (as `main.test.mjs` does) and reaches its
Claude-integration or catalog-refresh code paths, with no `HOME` override of
its own, spawns the real installer/mirror against the real machine.

## Scope

- Name every place the real home/config path can enter this repository.
- Give writers no default that can land on a real path.
- Add a guard that fails loudly under the test runner for a write outside
  the OS temp directory, and prove it fires (RED before the fix, GREEN
  after) without ever touching a real developer file.
- Constraint: never touch `~/.local/share/orca-jev-advisor/`, `.github/`,
  `.screenshots/`; strict TDD; 424 pre-existing tests must still pass.

## What was done

1. **`src/core/write_guard.ts`** (new) -- `assertSafeWriteTarget(targetPath,
   env = process.env)`. No-op unless `NODE_TEST_CONTEXT` is set (Node's own
   test runner sets this on every isolated test-file process it spawns, and
   it propagates through `sidecarEnv`'s `{...process.env}` to every
   grandchild). Under the test runner, throws
   `RealConfigWriteBlockedError` naming the exact path if it resolves
   outside the OS temp directory (both the lexical and realpath'd forms, to
   survive macOS's `/tmp` -> `/private/tmp`).
2. **`src/core/guarded_fs.ts`** (new) -- guarded stand-ins for the mutating
   `node:fs/promises` calls (`writeFile`, `mkdir`, `rename`, `rm`, `cp`,
   `chmod`), each calling the guard on its destination before delegating.
3. Rewired `adapters/orca/install-claude-integration.mjs` and
   `adapters/orca/write-secret-mirror.mjs` to import the guarded aliases
   instead of `node:fs/promises`'s own -- every mutating call in both files
   (~13 call sites total) is now guarded automatically, by construction,
   with zero per-call-site edits and nothing left to forget on a future
   write.
4. Removed the one bare "insidious default" found:
   `write-secret-mirror.mjs`'s `writeAtomic(content, path = MIRROR_PATH,
   mode)` -- a caller that forgot to pass `path` landed silently on the real
   mirror file. `path` is now required; both callers (`save`, `clear`) pass
   `MIRROR_PATH` explicitly.
5. Tests (11 new, all passing alongside the 424 pre-existing ones):
   - `src/core/write_guard.test.ts` -- unit tests of the guard itself.
   - `adapters/orca/install-claude-integration.write-guard.test.mjs` --
     spawns the real installer against a real-looking, non-isolated HOME
     (inside the checkout, never a real user's home) and asserts refusal
     and zero files written; also a sanity test that a normal mkdtemp-style
     install still succeeds.
   - `adapters/orca/write-secret-mirror.write-guard.test.mjs` -- same shape
     for `catalog-save`.

## Verified RED before GREEN

For each of the three test files, the guard/wiring was temporarily removed,
the test observed failing (RED, including one genuine bug: macOS's
`/tmp`->`/private/tmp` symlink made the first guard implementation reject a
legitimate mkdtemp path), then restored and observed passing (GREEN). The
two integration tests' RED runs actually reproduced the incident safely
(the unguarded installer/mirror wrote real files to a fixture location
inside the checkout, which was deleted immediately after).

## Root cause found

Confirmed: `resolveConfigDir`/`resolveOrcaUserDataDir` in
`src/core/paths.ts`/`src/core/orca_accounts.ts` are pure, take `home` as a
required argument, and never call `os.homedir()`/an OS API themselves --
they were never the leak. The leak was one level up, at the two sidecar
scripts' own module-level `os.homedir()`/`process.env` resolution, reached
unisolated whenever `main.mjs` spawns them with a real, unmodified
`process.env`.

## Not extended (disclosed, not fixed)

`adapters/claude/gate-bash.ts` and `gate-outcome.ts` also resolve
`os.homedir()`/env at module scope and write cache/log files with
synchronous `node:fs` (not `fs/promises`), so `guarded_fs.ts` does not cover
them. Both are already isolated by their own dedicated tests today (HOME
overridden per spawn), unlike the two sidecars this task fixed, which were
reached unisolated through `main.mjs`. Extending the guard to synchronous
`node:fs` for these two was out of scope for this pass; flagged as residual
hardening, not left silently unaddressed.

`main.mjs`'s own architecture still lacks an injection seam for
`installClaudeIntegration`/`uninstallClaudeIntegration`/
`attendClaudeIntegrationRequest` and `cmdRefreshCatalog` (unlike
`attendModSkillsConfigRequest`/`attendDenyTierConfigRequest`, which accept
`options.mirror`). This is no longer a safety hazard -- the sidecar's own
guard refuses the write regardless of caller -- but is still a code-quality
gap worth a future pass.

## Verification (evidence)

- `node --test --experimental-strip-types src/core/write_guard.test.ts` --
  7/7 pass.
- `node --test --experimental-strip-types adapters/orca/install-claude-integration.write-guard.test.mjs` --
  2/2 pass.
- `node --test --experimental-strip-types adapters/orca/write-secret-mirror.write-guard.test.mjs` --
  2/2 pass.
- `npm test` (full suite) -- 435/435 pass (424 pre-existing + 11 new), 0
  failures.
- `shasum ~/.claude/settings.json ~/.config/orca-supervisor/policies.json
  ~/.config/orca-supervisor/catalog.json` and `grep -c 'gate-bash.ts'
  ~/.claude/settings.json`, plus the four
  `.../orca/claude-accounts/*/auth/settings.json` fingerprints -- identical
  before and after every full run in this session.

## Status: done

TDD mode: strict, observed RED before GREEN on every new test file. No
mocks, no debug output, no backup files left in the repo. Branch:
`fix/test-isolation` off `main`, not pushed, no PR opened, per instruction.
