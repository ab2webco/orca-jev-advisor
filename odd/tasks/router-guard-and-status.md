# Model router: honest failure guard, and a status line that says why

## Objective
Stop the router from holding an expensive model because of harmless probe
errors, and make its status line say why it kept a model instead of pairing
Jev's stage with a model that stage would not pick.

## Problem
Evidence from `~/.cache/orca-supervisor/model-router-decisions-2026-09-27T20.jsonl`
(account acct0001, 2026-09-27):
- At 20:31:38 Jev judged the prompt `simple` (confidence 0.53) and the stage
  decision was `held-by-guard: previous-failure`. The previous turn's "failures"
  were exploratory probes that exited non-zero (`ls …/tsc` of a missing file,
  a `deno check` config lookup). The work itself had not failed.
  `summarizeRange` (`src/core/model_router_stage.ts`) adds 1 to `errors` for
  every tool result with `isError`, and `activeGuards`
  (`src/core/model_router_decide.ts`) raises `previous-failure` when
  `errors > 0`.
- The status line read `jev · modelo: Opus 5.5 · esfuerzo muy alto (etapa:
  consultar)`. "consultar" is Jev's tier (`stage.simple`), which would pick Haiku
  at low effort, while the model and effort shown are what was kept. The line
  gives no reason, so it reads as "a consult needs Opus at very high effort".

## Why
The owner wants the router to save money when a turn is light, with quality
guaranteed. A guard that fires on `ls` of a missing file blocks savings for no
quality reason. A status line that hides the reason makes the router look
wrong even when it is right, as it was with `break-even`.

## Scope (authorized by the owner 2026-09-27: "Sí")
- A: `src/core/model_router_stage.ts` (+ test). Errors from read-only probes
  no longer count toward `errors`. If the per-tool error link is missing,
  `adapters/claude/mod-skills/hooks/index.ts` gets the minimal change to
  carry it.
- B: `src/core/model_router_status.ts`, `src/core/i18n_model_router.ts`
  (+ tests), and the `routerStatusFor` call sites in
  `adapters/claude/mod-skills/hooks/index.ts`.
- README: one line each in the existing 0.6.1 section.

Out of scope: gate files (`src/core/command_shape.ts`, `gate_*`,
`decisions.ts`, `adapters/claude/gate-*`), which the gate-learning branches are
rewriting; `adapters/orca/*` and the board, which the board-tabs branch is
changing; version numbers, which 0.6.1 already bumps; any change to tiers,
thresholds or break-even.

## Constraints
- A read-only probe is a Read/Grep/Glob/LS tool call, or a Bash command whose
  every segment (split on `|`, `&&`, `||`, `;`) starts with a read-only
  program: `ls`, `which`, `command -v`, `type`, `test`, `[`, `stat`, `cat`,
  `head`, `tail`, `wc`, `file`, `grep`, `rg`, `find` without `-delete` or
  `-exec`, `pwd`, `echo`, a `--version` call, or `git` with `status`, `log`,
  `show`, `diff`, `rev-parse`, `branch --list`, `ls-files` or
  `check-ignore`. The classifier is self-contained in the model router code.
  Do not import from or edit the gate's `command_shape.ts`, because the
  gate-learning branches are rewriting it.
- Anything that is not clearly a probe still counts, to stay conservative.
  Failed tests keep counting exactly as today.
- Status "kept" wording, used only when the model and effort did not change
  but Jev's tier would have picked a different model:
  - es active: `jev · modelo: {{model}} · esfuerzo {{effort}} · se mantiene: {{why}} (Jev: {{stage}})`
  - es measure: `jev · mediría: {{model}} · esfuerzo {{effort}} · se mantendría: {{why}} (Jev: {{stage}})`
  - en active: `jev · model: {{model}} · {{effort}} effort · kept: {{why}} (Jev: {{stage}})`
  - en measure: `jev · would use: {{model}} · {{effort}} effort · would keep: {{why}} (Jev: {{stage}})`
  - The noEffort variants drop the effort segment.
  - `why` (es / en): low-confidence `poca confianza` / `low confidence`;
    previous-failure `falló el turno anterior` / `previous turn failed`;
    break-even `cambiar cuesta más de lo que ahorra` / `switching costs more than
    it saves`; hysteresis `esperando otro turno igual` / `waiting for another such
    turn`; prices-unknown `precios desconocidos` / `prices unknown`; client-site
    `sitio de cliente` / `client site`; policy `política` / `policy`;
    sensitive-topic `tema sensible` / `sensitive topic`.
  - Switches and same-tier decisions keep today's wording unchanged.
- Never use `any`. No debug statements. Artifacts are in English.

## Tasks
- [x] A: the previous-failure guard ignores read-only probe errors. RED
  first: a turn whose only error is `ls` of a missing file raises no
  guard; a failed `npm test`, a failed Edit and a failed `rm` still do.
  Then GREEN. One commit.
- [x] B: the status line says why it kept the model. RED first: rendered es
  and en strings for held-by-guard (low-confidence, previous-failure),
  break-even and hysteresis in both modes, and a switch whose text is
  unchanged. Then GREEN. One commit.

## Route per task
- A, B: delegated direct, one writer run sequentially. The writer trigger
  fired: stage.ts, status.ts, i18n and hooks/index.ts plus their tests.

## Checks
- TDD: enabled. Source: global `~/.claude/CLAUDE.md` "Strict TDD Mode:
  enabled". Runner: `npm test` (`node --test --experimental-strip-types`).
- Closure: full `npm test`, plus `npm run check`.
- Visual evidence: the status line is terminal text. The evidence is the
  rendered es/en strings from the tests, quoted in the report. A live
  on-screen check in a real session is pending until install and is reported
  as not looked at.
- RDD: disabled/unmanaged per the owner's decision (no Gentle AI reviews).

## Delivery
- Branch `dev/jev-061-router-guards`, stacked on `jev-061-origin` at
  c21f199 (0.6.1, 2 commits, not pushed, owned by another session that is
  awaiting input). Worktree
  `/home/dev/Projects/orca-supervisor-router-guards`. `node_modules`
  is a symlink and is never staged. No upstream.
- Forecast is about 250 authored lines, under budget. It lands with 0.6.1.
- Integration: before anything goes to `main`, the parent merges 0.6.1 +
  this branch + `dev/board-tabs-names` on a throwaway branch from
  `origin/main` and runs the full checks. It also dry-runs a merge against
  `dev/gate-approval-learning-b3a` to list conflicts.
- Push, PR and merge are the owner's decisions.

## Progress
- 2026-09-27: document created. Worktree ready. Writer not started.
- 2026-09-27: A done (route: delegated writer). The per-tool error link
  was already there: `hooks/index.ts` passes `$.session.messages()` rows
  straight to `summarizePreviousTurn`, and the engine's `SessionMessage`
  carries `tool_use_id` on every `toolUses` entry and `toolResults` entry
  (plus `toolUses[].isError`), so the hooks module needed no change.
  `ActivityMessage` gains the optional `tool_use_id` on both; an error
  result counts unless its `tool_use_id` names a read-only probe's call in
  the same range (an unlinked result still counts). The classifier
  (`isReadOnlyProbe`, private to `model_router_stage.ts`) splits quote-aware
  on `|`, `||`, `&&`, `&`, `;` and newlines, and is not a probe on any
  `$(`, backtick, `<(`/`>(`, or unquoted `>` that is not to `/dev/null` or a
  descriptor duplicate. RED (`node --test --experimental-strip-types
  src/core/model_router_stage.test.ts`): 32 tests, 2 fail -- "a read-only
  probe that fails (ls of a missing file) raises no guard" (errors actual
  1, expected 0) and "which failed calls are read-only probes" (`Read
  {"file_path":"missing.ts"} is a probe`, actual 1, expected 0); the
  regression pins (failed `npm test`, Edit and `rm` each count once and
  raise the guard; an unlinked result counts) pass before and after.
  GREEN: 32/32. Full `npm test`: 2050 pass, 0 fail. README: one 0.6.1
  line. Commit `441b6d8`.
  Observed limit: `deno check` and `cd` are not on the probe list, and the
  logged 20:31:38 turn had confidence 0.53 < 0.70, so that decision would
  still be held, now by `low-confidence`.
- 2026-09-27: B done (route: delegated writer). `model_router_status.ts`
  gains `keptWhy(decision)`: null unless the decision did not change, Jev
  answered, and Jev's tier resolves to another model than the one kept
  (base ids compared, so a `[1m]` session is the same model); then
  `held-by-guard` names its guard, and `low-confidence`, `hysteresis`,
  `break-even` and `prices-unknown` name themselves. A held-by-guard with
  no guard keeps today's wording. `routerStatusText` takes the optional
  `kept` and uses the four `status.*.kept.*` templates and `why.*` labels
  verbatim from Constraints. Both `routerStatusFor` call sites (start and
  stage) now pass reason, guard, changed and proposed. RED: the three
  rendering tests failed with today's wording (e.g. actual `jev · modelo:
  Opus 5.5 · esfuerzo muy alto (etapa: consultar)`, expected `… · se
  mantiene: falló el turno anterior (Jev: consultar)`), the file as a
  whole on the missing `keptWhy` export, and three hooks assertions (the
  hysteresis turn, the sensitive-topic hold, a measure-mode start held by
  low confidence) showed `… high effort (stage: ask)`. GREEN: status and
  hooks tests 74/74; full `npm test` 2057 pass, 0 fail. The four
  pre-existing status tests are unchanged and pass (switch wording
  intact), and the hooks downgrade test asserts the switch turn still
  reads `jev · model: Haiku 4.5 (stage: ask)`. Types: a strict
  (`noUncheckedIndexedAccess`) `deno check` of the changed core files,
  their tests and `hooks/index.ts` reported no errors (the repo has no
  `tsc`; run from a throwaway config, not kept). README: one 0.6.1 line.
  Commit: the one that checks this box. Visual: terminal text only; the
  rendered strings are the evidence, and a live status line in a real
  session is not looked at (pending install).

## Next step
Parent: `npm run check` result is in the writer's report; then the
integration merge described under Delivery.
