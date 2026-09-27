# Jev Advisor 0.6.0 slice 1 — measure and show consumption

## Objective
Give the owner visibility into where Claude Code token consumption goes
(cache reads/writes/output, main vs subagent, per-model, weekly quota) before
building the model/effort router in slice 2. No behavior change.

## Problem
The owner is on a Max 5x weekly limit, currently at 81% with 4 days left.
Measured traffic shows the cost is dominated by cache re-reads (74% Sonnet,
57% Opus), and switching model/effort mid-session busts the per-model cache.
There is currently no visibility into this on the board.

## Why
Per brief `brief-060-slice1.md`: informed router decisions in slice 2 require
real usage data first. This slice only measures and displays.

## Scope
- `adapters/claude/mod-skills/hooks/index.ts` — pass-through `turn.step` hook
  recording per-step usage to `turn-usage.jsonl`.
- `adapters/orca/main.mjs` — quota mirror (`orca account list --json` →
  `quota.json`, every 10 min + on activation).
- `src/core/` — pure aggregation functions (usage aggregation, quota parsing,
  recommendation triggers).
- A worker-side script (mirroring `read-measurements.mjs`) that aggregates
  `turn-usage.jsonl` + `quota.json` and publishes a summary to storage.
- `adapters/orca/panels/board.html` — "Consumo"/"Consumption" card, i18n,
  empty state.
- Tests: `src/core` unit tests, a hooks unit test, a Playwright test in
  `scripts/panels.spec.mjs`.

## Out of scope
The model/effort router itself (slice 2). Any change to what Claude does.

## Constraints
- No `any`. No debug statements (`console.log`/`debugger`) left in. No backup
  files.
- `$` in the hooks file only passed to top-level functions declared in the
  same file (`hooks/index.ts`); `$.noun.method(...)` call-site spelling;
  `$.env.get` literal name; named `export function register`. Keep
  `adapters/orca/mod_skills_validate.test.mjs` green.
- No prompt text or content ever recorded, only usage numbers/metadata.
- Quota mirror failure logged once, never throws.
- Board copy in Spanish + English, accented, no " -- ". **Correction**: the
  only existing test enforcing this (`src/core/i18n_catalogs.test.ts`) is
  scoped to the `src/core/i18n_*.ts` catalogs — it does not read
  `board.html`'s own inline `CATALOG` object at all. T5 must add a narrow
  test (in `scripts/panels.spec.mjs`, via `page.evaluate(() =>
  window.CATALOG)`, same technique the existing `models.*`/`catalog.*`
  key-parity tests there already use) scoped to just its own new keys, or
  the "enforced by test" requirement is not actually met. Not auditing
  every pre-existing board.html string — out of scope.
  No new colors — reuse existing CSS custom-property tokens.
- Tests never touch real `~/.config/orca-supervisor`, `~/.cache/orca-supervisor`,
  `~/.claude*` — use `ORCA_SUPERVISOR_CONFIG_DIR`/`ORCA_SUPERVISOR_CACHE_DIR`
  isolation and temp dirs.
- This worktree has no `node_modules`. Symlink the main checkout's while
  testing (`ln -s /home/dev/Projects/orca-supervisor/node_modules node_modules`),
  `unlink node_modules` before every commit.
- Never push. Conventional Commits, no AI attribution / Co-Authored-By.

## Delivery
Strategy: `ask-on-risk`. Forecast: ~450-550 authored changed lines across 6
tasks (mildly over the ~400-line heuristic; the slice has five genuinely
separate mechanisms — hook, quota mirror, aggregation, worker wiring, board
UI — each needing its own tests, so kept as one coherent feature rather than
split for its own sake).
TDD: strict (repo default, per CLAUDE.md "Strict TDD Mode: enabled").
Runner: `node --test --experimental-strip-types` (unit), Playwright via
`node --test scripts/panels.spec.mjs` (panels).

## Known decision gaps (resolved with a stated default, not blocking)
- **File layout for turn-usage records**: the brief says to mirror an
  existing rotation approach; mapping found none — every existing measurement
  file (`mod-skills-measurements.jsonl`, ab-benchmark samples) caps write
  *rate*, never file size, and always read-then-rewrites the whole file on
  every append (`$.fs` has no append primitive). A first pass tried a single
  ever-growing `turn-usage.jsonl` with a 25k/20k line trim; review caught that
  `turn.step` fires once per model step (far more often than the per-prompt
  logs this pattern was copied from) and that `$.fs.read`/`$.fs.write` both
  reject outright above 4 MiB — so that file would have silently stopped
  recording well before the line-count trim ever ran. **Corrected**: one file
  per hour (`turn-usage-YYYY-MM-DDTHH.jsonl`, ~200 lines/~50 KB at typical
  volume); an append only ever rewrites the current hour's own small file.
  The worker-side aggregator (T4) reads the hourly files across its 24h/7d
  windows and prunes ones older than 8 days. No rotation logic remains in the
  hook itself.
- **Account-uuid-from-`CLAUDE_CONFIG_DIR` parser**: none exists; writing a
  fresh regex (`/claude-accounts[\\/]([^\\/]+)[\\/]auth/`) against
  `$.env.get('CLAUDE_CONFIG_DIR')`, falling back to `"home"`.

## Tasks
- [x] T1 `turn.step` usage-recording hook in `hooks/index.ts` (pass-through,
      never mutates `e`), appends JSONL to the current hour's own
      `turn-usage-YYYY-MM-DDTHH.jsonl` via `resolveHomePaths($).cacheDir` (see
      decision gap above — corrected from a single-file line-count trim after
      review). Unit test mirrors `hooks.test.ts`'s fake-`$` pattern, plus an
      hour-isolation test. Keep `mod_skills_validate.test.mjs` green.
      Route: delegated, then one direct-inline correction after review.
      Trigger: writer (hook logic + its test file).
- [x] T2 Quota mirror in `main.mjs`: `setInterval` (10 min, `.unref()`d,
      cleared in teardown, mirroring the existing `MEASUREMENTS_REFRESH_MS`
      interval) + one call on activation, running
      `orca account list --json` via `ORCA_CLI_BIN`/`execFileAsync`, writing
      `quota.json` atomically (temp+rename) to the plugin config dir.
      Failure logged once (dedup flag), never throws.
      Route: delegated. Trigger: writer (main.mjs + its test).
- [x] T3 Pure functions in `src/core/`: aggregate the hourly
      `turn-usage-*.jsonl` records over 24h/7d (per-model cache-read/write/output share + step count,
      average context re-read per step, main-vs-subagent share); parse
      `quota.json`; compute each recommendation's trigger (CLAUDE.md size
      >8k tokens, MCP server count, avg main-step context >150k tokens,
      subagent share >40%). Unit tests first (RED), then implementation
      (GREEN).
      Route: delegated. Trigger: writer (2+ new files) + mapping was already
      done upstream.
- [x] T4 Worker wiring: a script mirroring `read-measurements.mjs` that calls
      the T3 aggregation over the real hourly files, invoked from `main.mjs`
      alongside the existing measurements interval, publishing a
      `consumptionSummary` to `storageHost` (mirrors
      `publishMeasurementsSummary`); also deletes `turn-usage-*.jsonl` files
      older than 8 days (see decision gap above). Test that publish happens,
      shape is correct, and pruning removes only files past the 8-day
      threshold, under isolation env vars.
      Route: delegated. Trigger: writer (main.mjs + new script + test).
- [x] T5 "Consumo"/"Consumption" card in `board.html`: markup mirroring an
      existing card, ES/EN i18n keys (accented, no " -- "), reads
      `consumptionSummary` via the storage bridge, renders per-model shares,
      avg re-read, main/subagent split, quota bars with reset time, and the
      plain-language recommendations only when their trigger fires. Honest
      empty state when there is no data yet. No new colors.
      Route: delegated. Trigger: writer (board.html, non-trivial).
- [x] T6 Playwright test in `scripts/panels.spec.mjs` for the card
      (populated + empty state), following the existing `openBoardPanel`/
      `hostBridge` pattern; confirm `touchingControls(page)` still returns
      `[]` for the board.
      Route: delegated. Trigger: writer (test file, non-trivial, depends on
      T5's exact markup).
- [x] T7 Visual evidence: `npm run shots` (4 images) + board with populated
      consumption card at 1440 light and 390 dark. Read every image, report
      what was seen, fix anything that looks wrong.
      Route: inline (verification, not a new mechanism) or delegated if it
      requires code fixes beyond a one-line CSS tweak.
- [x] T8 Final verification pass: `npm test`, `npm run test:panels`,
      `npm run shots`, `claude plugin validate` (via the existing test), and
      writing the report to the path the brief specifies.
      Route: inline.

## Progress
- 2026-09-26: mapping pass completed (read-only), findings folded into scope/
  constraints/decision gaps above. Task file created before first write.
- 2026-09-26: T1 done and committed (94fc299). `handleTurnStep` registered on
  `turn.step` in `hooks/index.ts`, pass-through (`yield* next(e)`, `e` never
  rewritten), records one JSONL line per step to `turn-usage.jsonl` under
  `resolveHomePaths($).cacheDir`, with the original 25k/20k trim default. 5
  new tests in `hooks.test.ts` (17/17 green). `mod_skills_validate.test.mjs`
  ran against the real `claude` binary: pass.
- 2026-09-26: review of 94fc299 caught that `$.fs` has no append (confirmed
  in `claude-code.d.ts`: `read`/`write` both reject above 4 MiB) — a single
  growing `turn-usage.jsonl` would read-then-rewrite the whole file on every
  step and could silently stop recording before the 25k-line trim ever ran.
  Corrected T1 in place (direct inline: one file, unambiguous spec from
  review, no new design decision left open): hourly files
  (`turn-usage-YYYY-MM-DDTHH.jsonl`), rotation logic removed from the hook,
  pruning moved to the T4 worker aggregator (>8 days). Replaced the old
  rotation test with one asserting an append never touches an older hour's
  file. `hooks.test.ts`: 17/17 green after the fix.
- 2026-09-26: T2 done and committed. `mirrorAccountQuota` in `main.mjs`:
  fetches `orca account list --json` (new `ORCA_CLI_ARGUMENTS.accountList`
  in `src/core/orca_cli.ts`, called through `ORCA_CLI_BIN`/`execFileAsync`
  like every other CLI call in this file), keeps only `provider: "claude"`
  accounts, reshapes each to `{id, status, sessionUsedPercent,
  weeklyUsedPercent, resetsAt, fableWeekly?}` (no email, no auth), and
  mirrors the result to `quota.json`. Wired into `activate()`: one call at
  activation plus a 10-minute `.unref()`'d interval, cleared in the same
  teardown as `measurementsTimer`. A CLI or write failure is logged once
  (dedups on identical detail, resets after a success) and never throws.
  **Deviation from the literal task text, flagged**: the worker cannot
  write `quota.json` directly — measured, not assumed (main.mjs's own
  header/`mirrorSecretToEnvFile` doc: "the worker's own permission sandbox
  only allows reading its plugin root, and writing there threw rather than
  resolving"). So instead of a local temp+rename helper in `main.mjs`, the
  write goes through the existing `write-secret-mirror.mjs` sidecar (a new
  `quota-save` mode there, reusing its shared `writeAtomic`), the same path
  `mirrorCatalogAndPolicies` already uses for catalog.json/policies.json.
  Both `fetchAccountQuotas` and the write step are injectable
  (`options.fetchAccountQuotas`/`options.saveQuota`), mirroring
  `computeCatalogProposals`'s own `fetchOrcaWorktrees` override convention,
  so tests never shell out or spawn a real sidecar. 4 new tests in
  `main.test.mjs`, 2 new end-to-end tests in
  `write-secret-mirror.write-guard.test.mjs` (quota-save guarded the same as
  catalog-save/models-save). Full `npm test`: 1821/1821 green.
  `mod_skills_validate.test.mjs` ran against the real `claude` binary: pass.
- 2026-09-26: review of the T2 commit found `accountQuotaTimer` was created
  and `.unref()`'d but never cleared in `activate()`'s teardown — the
  teardown only cleared `measurementsTimer`, so the interval would keep
  firing (harmlessly, since `.unref()`'d, but inconsistent with the spec's
  own "cleared in teardown" requirement and every other interval in this
  function) past a torn-down activation. Fixed direct inline (one-line,
  mechanical, matches the existing `measurementsTimer` pattern exactly — no
  new test added, since `activate()`'s wiring has no test harness anywhere
  in this codebase, a boundary the T2 agent's own tests already respected by
  testing `mirrorAccountQuota` directly instead). `main.test.mjs`: 88/88
  green after the fix; full `npm test`: 1821/1821 green.
- 2026-09-26: T3 done and committed (dee7953). New `src/core/consumption.ts`
  + `consumption.test.ts` (27 new tests, RED confirmed against the missing
  module, then GREEN). `aggregateTurnUsage(records, nowMs)` folds
  already-parsed turn-usage rows into 24h/7d windows: per-model
  `{cacheReadShare, cacheWriteShare, outputShare, stepCount}` (share reading
  picked: WITHIN that model's own total input+output+cacheRead+cacheWrite,
  never across models -- matches the brief's own "74% Sonnet, 57% Opus"
  phrasing), `avgMainStepContextReread` (mean of `cacheRead` scoped to
  `agent === "main"` only, per the later "average context per main step"
  trigger wording), and `subagentShare` (subagent's null-safe token total /
  grand null-safe total). `parseQuota(raw)` tolerantly normalizes quota.json
  (drops an account with no string `id`; never fabricates `fableWeekly`).
  Four independent trigger functions (`claudeMdSizeTrigger`,
  `mcpServerCountTrigger`, `longSessionTrigger`, `subagentShareTrigger`),
  each returning real numbers, not bare booleans; MCP count has no
  brief-specified threshold, so it returns `{count}` only, scoped to the
  global `.claude.json` only (no per-account file exists to sum). Full
  `npm test`: 1848/1848 green (1821 + 27 new).
- 2026-09-26: T4 done and committed (181a634). New
  `adapters/orca/read-consumption.mjs` (+ `read-consumption.test.mjs`, 9
  new tests, RED confirmed by temporarily moving the script aside and
  observing MODULE_NOT_FOUND, then restored to GREEN): lists
  `turn-usage-*.jsonl` in the cache dir, reads/guards each row into T3's
  `TurnUsageRecord` shape (malformed rows counted as corrupt, never
  thrown on), feeds the valid rows to `aggregateTurnUsage`, then deletes
  any file whose hour bucket is more than 8 days before `Date.now()`
  (parsed from the filename itself; an unparseable bucket is left alone).
  Reads `quota.json` from the config dir and the global `CLAUDE.md`/
  `.claude.json` from `home`/`homeConfigTarget(...).configDir` -- both
  tolerant of a missing or unparseable file (degrades to the empty/`null`
  shape, never fails the script). Prints `{ok, usage, quota,
  recommendations}`, `recommendations` holding only the triggers that have
  real data (`mcpServerCount` always, since 0 is honest data, not "no data
  yet").
  `main.mjs`: `CONSUMPTION_SCRIPT`/`CONSUMPTION_STATUS_KEY`
  (`'consumptionSummary'`)/`CONSUMPTION_REFRESH_MS` (reuses
  `ACCOUNT_QUOTA_REFRESH_MS`'s 10-minute value outright, documented why:
  this sidecar scans up to ~192 hourly files and prunes on every call, far
  heavier than the 15s measurements cadence was sized for), plus
  `readConsumptionSummary`/`publishConsumptionSummary` mirroring the
  measurements pair, with an injectable `options.readConsumptionSummary`
  on `publishConsumptionSummary` (T2's own override convention) so
  `main.test.mjs`'s 3 new tests never spawn a real child. Wired into
  `activate()`: one call at activation, its own `.unref()`'d interval,
  cleared in the same teardown as `measurementsTimer`/`accountQuotaTimer`.
  Permission grants: `PLUGIN_ROOT` read, `CACHE_DIR` read+write (write is
  new -- for pruning), `CONFIG_DIR` read, `CLAUDE_HOME_DIR` read (the
  existing constant; also covers the sibling `~/.claude.json` via the
  sandbox's own string-prefix grant matching, not a directory-containment
  one). Full `npm test`: 1860/1860 green (1848 + 12 new: 3 in
  `main.test.mjs`, 9 in `read-consumption.test.mjs`).
  `mod_skills_validate.test.mjs` ran alone against the real `claude`
  binary: pass.
- 2026-09-26: the "string-prefix grant" claim in the T4 note above was
  **wrong** — checked by hand, not assumed: `node --permission
  --allow-fs-read=<home>/.claude -e "readFileSync('<home>/.claude.json')"`
  gives `ERR_ACCESS_DENIED`. Node's sandbox does exact/ancestor-directory
  matching; `.claude.json` sharing a string prefix with `.claude` does not
  extend the grant to it. Real-world effect, confirmed by running the actual
  sidecar under the actual flags: `mcpServerCount` would have silently read
  `0` forever in production — never a crash (the sidecar's own tolerant
  degrade-on-missing-file design absorbed the denial), never visible in any
  test (every existing test either fakes the spawn away or runs the script
  fully unsandboxed with no `--permission` at all). Fixed direct inline: a
  new `CLAUDE_JSON_PATH` constant (`join(HOME_PATHS.home, '.claude.json')`,
  matching `read-consumption.mjs`'s own path exactly) with its own
  `--allow-fs-read` grant. Verified end-to-end by hand against a real
  sandboxed spawn (temp HOME, real `--permission` flags): `mcpServerCount`
  reads correctly with the grant, reads `0` without it. Also extracted the
  sidecar's argv into `consumptionSidecarArgv()` (exported for tests) and
  added two regression tests in `main.test.mjs` pinning its exact shape —
  RED confirmed by temporarily removing the `.claude.json` grant and
  re-running, then GREEN restored. Full `npm test`: 1862/1862 green (1860 +
  2 new). `mod_skills_validate.test.mjs`: pass.
- 2026-09-26: T5 and T6 done and committed together (one commit; the test
  and the card were written in the same pass, per this codebase's own
  convention). New `#card-consumption` (`class="card wide"`, in the existing
  `.cards` grid -- no new `grid-template-areas` needed, unlike `.top`'s named
  areas) with `renderConsumption(summary)` in `board.html`, wired into
  `reload()` via a fifth `read('consumptionSummary', usuario)`. Four RED
  Playwright tests added first in `scripts/panels.spec.mjs` (populated,
  empty, `ok:false`, catalog parity/accent) -- confirmed RED against the
  pre-implementation `board.html` by temporarily setting it aside with a
  tagged `git stash` (kept the new tests loaded, ran
  `node --test --test-name-pattern="consumption"`, all 4 failed: missing
  `#consumption-body`/no `consumption.*` keys), then `git stash apply` to
  restore before implementing, then dropped the stash. GREEN after
  implementing; two of the four needed a follow-up fix (asserting on
  `#consumption-body` instead of the whole `#card-consumption`, which is
  blank in the empty/failure states by the `fill()` helper's own design --
  the helper is correct, the assertion target was wrong).
  Decisions not fully specified in the brief, made here:
  - Primary display window: `last24h` when it has any steps, else `last7d`
    -- last24h is the more actionable window, but falling back avoids
    showing "no data" right after an hour/day boundary when the 7-day
    window still has real history. The four recommendation triggers are
    NOT re-derived from this choice -- they render straight from
    `recommendations`, which `read-consumption.mjs` always computes from
    `last24h` specifically, independent of which window this function
    picks for the raw per-model/context/subagent display.
  - `resetsAt` unit: epoch milliseconds, confirmed by reading
    `main.test.mjs`'s own quota fixtures (13-digit values, e.g.
    `1790568000000`) and `main.mjs`'s `accountQuotaEntry` -- not assumed.
    Formatted with `Date#toLocaleString` (month/day/hour/minute), locale
    matched to `currentLocale` (es-ES/en-US).
  - `mcpServerCount` is purely informational, never the `.stale` warning
    tone -- the brief states no threshold for it, so there is nothing to
    warn about, only a fact to report.
  - A present trigger with `overThreshold: false` (longSession,
    subagentShare) renders a quiet confirming line in the neutral
    `.empty-line` tone ("in a healthy range" / "within a reasonable
    range") rather than nothing -- reassurance that real data was checked
    and it is fine, consistent with never leaving a checked thing
    unmentioned. `claudeMdSize` always shows its base sentence (the real
    estimated token count) and adds a second `.stale` sentence only when
    `overThreshold` is true.
  - Key prefix: `consumption.*`, scoped by its own new parity + accent/no-
    " -- " test in `panels.spec.mjs` (`src/core/i18n_catalogs.test.ts` never
    reads `board.html`'s inline `CATALOG`, per this file's own earlier
    correction).
  - Empty-state convention: mirrored config.html's `modelsRenderMeasurements`
    (its own doc: "Three states, never two") rather than board.html's own
    `renderStats`, because `renderStats` actually collapses `ok:false` and
    "never loaded" into the same generic `card-empty` copy -- the wrong
    prior art for this card's explicit "ok:false must read as a distinct
    failure" requirement. `!summary` (never loaded) and a genuine
    `ok:true` empty payload (`stepCount === 0` in both windows and no
    quota accounts) share the same honest "no data yet" copy; `ok:false`
    gets its own "could not be calculated" sentence; only real numbers
    render the populated card.
  - No new CSS: per-model/quota bars reuse `.hrow`/`.htrack`/`.hfill` (a
    new `barRow()` helper, since `hbars()` scales against the largest row
    in its own list -- wrong shape for an independent percentage); the
    `overThreshold` warning tone reuses `.stale` (`--destructive`), the
    same token `noteEl`'s worker-silent state already uses.
  `touchingControls(page)` still returns `[]` for the board (the card adds
  no button/link/select/input/[role=tab] elements, only text) -- reused the
  existing dedicated board test rather than adding a redundant one.
  Full `npm test`: 1862/1862 green (unchanged -- T5/T6 touched no `src/core`
  or adapter code). Full `npm run test:panels`: 70/70 green (66 existing +
  4 new), confirmed with Playwright actually installed and running (not
  skipped).
- 2026-09-26: T7 done. `npm run shots` (the `ready` scenario) photographs
  the Consumption card in its EMPTY state -- `ready` never carried a
  `consumptionSummary` fixture -- so a populated shot needed its own
  scenario: added `consumption-ready` to `scripts/screenshot-panels.mjs`
  (`{...READY, consumptionSummary: <the same realistic fixture
  panels.spec.mjs's own POPULATED_CONSUMPTION uses>}`), run as `node
  scripts/screenshot-panels.mjs --quick --scenario consumption-ready`.
  8 images read in total (4 from `npm run shots`, 4 from the new
  scenario -- `screenshot-panels.mjs` empties `.screenshots/` on every
  run, so the two sets were taken in separate invocations and merged):
  - `ready-board-light-1440`/`ready-board-dark-390`: Consumption card
    renders its honest empty state ("No consumption data yet...") at the
    bottom of the board, styled consistently with the surrounding cards,
    no overflow.
  - `ready-config-*`: unaffected, unchanged from before this slice.
  - `consumption-ready-board-light-1440`/`-dark-390`: populated card
    renders per-model cache-read/write/output bars (claude-sonnet-4-5 30
    steps, claude-opus-4-1 12 steps), "Average context re-read per main
    step: 162,345 tokens.", "Subagents use 47% of usage...", one quota
    account's Session/Weekly bars (12.4%/81.2%) with "Resets: Oct 3, 6:00
    PM", and all four recommendation lines -- the three over-threshold
    ones in the board's existing `.stale` red, the informational MCP-count
    line in the normal text color. Bars render at proportional widths, all
    text fits at 390px in both themes, nothing overlaps.
  - `consumption-ready-config-*`: identical to `ready-config-*` as
    expected (config.html does not read `consumptionSummary`).
  Nothing looked wrong; no fix needed. New scenario committed alongside
  this note (screenshot fixture only, no src/core or adapter change).
- 2026-09-26: T8 done. Final fresh verification run, after every commit
  above: `npm test` 1862/1862, `npm run test:panels` 70/70 (Playwright
  genuinely installed, not skipped), `mod_skills_validate.test.mjs` alone
  against the real `claude` binary (on PATH at
  `/home/dev/.local/bin/claude`): pass, `npm run shots`: 4 images,
  no overflow, no script errors. Working tree clean, `node_modules`
  unlinked. Report written to the path the brief specifies. Slice done.
- 2026-09-26 (round 4): owner reviewed the populated screenshot directly
  and caught a real defect — Sonnet's three rendered shares summed to
  74+10+5=89, not 100, because the fourth field (uncached input) had no
  share or row. Three fixes, three commits: `929bec6` adds `inputShare` to
  `ModelUsageShare` + an "Input (uncached)" row + a shares-sum-to-100%
  test (unit + Playwright); `d481bf6` swaps the screenshot fixture's
  outdated model ids (`claude-sonnet-4-5`/`claude-opus-4-1`) for the real
  current ones (`claude-sonnet-5`/`claude-opus-5-5`, `seed/models.json`);
  `492ae8e` adds friendly model names (Sonnet 5/Opus 5.5/Haiku 4.5/Fable
  5.1, falling back to the raw id) with the raw id moved to a `title`
  attribute — `panels.spec.mjs`'s own id-swap rode along with this last
  commit since its assertion-update and id-swap were the same changed
  lines. Note: an initial delegated pass on this round left all three
  fixes uncommitted with `node_modules` still linked after twice reporting
  "waiting on a background test run" that never resumed; fix 1 alone was
  salvaged and committed as-is (it was correct), fixes 2 and 3 were
  redone directly rather than resumed a third time. A `--test-name-pattern`
  filtered rerun also misbehaved (ran the whole file sequentially instead
  of filtering) and was abandoned in favor of full untruncated runs.
  Final fresh `npm test`: 1863/1863. Final fresh `npm run test:panels`:
  70/70. Regenerated `consumption-ready-board-{light-1440,dark-390}.png`
  and read both personally: friendly names render, four bars per model
  sum to 100%, current ids confirmed. Report appended with this round.
