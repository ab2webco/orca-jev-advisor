# Release 0.6.18: a real typecheck, and the gate's last unguarded inputs

## Objective
Make types a checked fact rather than an intention. The project runs TypeScript through Node's `--experimental-strip-types`, which erases types without checking them, so a type error passes every test. Measured on main ff21657 with TypeScript 5.9.3 in strict mode: 65 errors, 16 of them in production code. Then close the self-protection gap 0.6.17 left: the Orca storage the mirrors are rewritten from, and Claude Code's own hook entries.
Authorized by the owner 2026-10-01 ("porque no instalas tsc si se necesita para las pruebas?", repeated).
Plane: JEVADV-95, JEVADV-94.

## Scope
- T1 JEVADV-95, the typecheck in place:
  - `typescript` and `@types/node` as devDependencies.
  - A `tsconfig.json` that matches how Node runs the code: strict, `noEmit`, `module`/`moduleResolution` `nodenext`, `allowImportingTsExtensions`, and `erasableSyntaxOnly` / `verbatimModuleSyntax` if they hold on the current code (record why if not). It covers `src/`, `adapters/` and the `.ts` test files.
  - An `npm run typecheck` script, included in `npm run check` and in the CI job, so a type error fails CI.
  - This task only lands the tooling with the current error count recorded. CI goes red-to-green in T2, so land T1 and T2 together in one PR.
- T2 JEVADV-95, fix every error, production first:
  - The 16 production errors, among them gate-bash.ts:1616/1665 (`label`/`kind` read off a `MirroredDestination` that does not declare them), deny_rule_shapes.ts:332/335 (`string | null` where `string` is required), ab_benchmark_cli.ts (`argv`/`exitCode` on a narrowed process type), mod-skills hooks index.ts:766/2376, command_text.ts:335, mod_skills_copy.ts:146, gate-bash.ts:1408/1623.
  - For each one, decide whether it is a real runtime bug or only a missing annotation, and record the answer. A real bug gets a failing test first (Strict TDD), then the fix.
  - Then the 49 test-file errors.
  - No `any`, no `as unknown as`, no blanket `@ts-ignore` / `@ts-expect-error`. A cast is allowed only where the value is narrowed by a check, with a comment saying which check.
  - End state: `npm run typecheck` exits 0.
- T3 JEVADV-94, the gate's last unguarded inputs:
  - The plugin's Orca `storage.json`, which the panel and worker rewrite the mirrors from, joins the protected set of 0.6.17 T2. That covers Bash and the file-tool hook, and the Orca profile path is resolved the way the gate already resolves `orca-data.json`.
  - Decide whether Claude Code's `settings.json` hook entries (the agent could remove the gate's own entries) are covered here, and record the decision. The installer writes them, and a person edits them by hand legitimately.
  - Move any of the lead's QA scripts that edit the storage by script to a test profile.
  - Keep 0.6.17's checks: no match on the 0.6.15 false-positive corpus, no Jev call in the file hook.
- T4 README (latest "What changed"), CHANGELOG, QA in `odd/qa/qa-0.6.18.md`, release, live check.

## Checklist
- [x] T1 typescript, tsconfig, `npm run typecheck` in check and CI. devDependencies `typescript` ^5.9.3 (5.9.3 installed and tested; npm's latest is 7.0.2, the native port, not used: the task names 5.9 and 7 is a different compiler) and `@types/node` ^24.19.0 (the `engines` major). Still no package-lock.json: .gitignore already records why (Orca clones this tree onto every user's machine and installs nothing; a lockfile only weighs on them), and CI keeps `npm install`. Three configs, one script, `npm run typecheck` = `tsc -p tsconfig.json && tsc -p adapters/claude/mod-skills/tsconfig.json && tsc -p adapters/claude/mod-skills/tsconfig.test.json`:
  - `tsconfig.json` (Node-run code, src/ and adapters/ with their tests): strict, noEmit, target/lib es2024, module/moduleResolution nodenext, allowImportingTsExtensions, erasableSyntaxOnly, verbatimModuleSyntax (both hold on the current code: no error comes from either), skipLibCheck, types node. It excludes adapters/claude/mod-skills/: that hooks module runs in Claude Code's own environment (no Node, its own web globals), and its `claude-code.d.ts` declares a global `URL` that merges with Node's and breaks every `readFileSync(new URL(...))` in the Node tests (20 false errors when mixed).
  - adapters/claude/mod-skills/tsconfig.json (already in the repository, unchanged): the hooks environment as Claude Code types it (types [], bundler resolution, noUncheckedIndexedAccess). It was never run; it reports 6 errors, 3 of them in src/core/tool_decisions.ts, which the hooks module imports.
  - adapters/claude/mod-skills/tsconfig.test.json (new): the three mod-skills tests, which `node --test` runs under Node, with the root options plus `claude-code.d.ts`.
  - Removed src/core/node-builtins.d.ts, the hand-written Node shim for a typecheck without @types/node: with @types/node it shadowed the real types (`process` without `argv`/`exitCode`/`execPath`, `readFileSync` without URL, a `createHash` without chaining), which accounted for 21 of the 65 measured errors (4 of the 16 production ones: ab_benchmark_cli.ts argv x2 and exitCode, mod_skills_copy.ts digest), none of them an error in the code.
  - `typecheck` runs first in `npm run preflight`, so in `npm run check`, which the CI job runs in the same job as the tests; the workflow comments say so (YAML parsed: steps checkout, setup-node, npm install, playwright install, npm run check, upload).
  Measured on this branch: the lead's probe config (shim included) 66 errors (65 plus src/core/file_url_paths.test.ts:18, added on main since); the configs above, before any fix, 47 distinct errors (51 reported, 4 seen by two configs): 15 production, 32 test. `npm run typecheck` exit 2 (expected until T2). npm test 2932/2932.
- [x] T2 every type error fixed; real bugs with a failing test first. `npm run typecheck` exit 0 (47 distinct errors -> 0). npm test 2936/2936 (2932 + 4 new).
  Production, 15 (the lead's 16 less the 4 that only the removed shim produced, plus the 3 the hooks-environment config found), each decided:
  - Real bug, gate-bash.ts:1616 and :1665 (`label`/`kind` read off a `MirroredDestination` that did not declare them). The mirror is the panel's whole catalog row, so they are there at run time, but unchecked: a row without a string label reached jev_pseudonyms' `destinationDescription` as undefined, threw inside askJev's try, and every command in that destination was judged as if Jev were unreachable (`kind: 'none'`). The repository's own gate tests write such rows. Fix at the source: `label`/`kind` declared `unknown` on the mirror type (not validated by the parser, on purpose: a malformed one must not take the row's policies and ceiling with it), read through the new `mirroredDestinationContext` (both strings, or no destination context); `destinationKind` is recorded only when a string. RED: gate_catalog_mirror.test.ts 0/1 (export missing); GREEN 17/17 (3 new tests).
  - Real bug, deny_rule_shapes.ts:332/335 (`string | null` passed where `string` is required). `pushTargets` read a push whose directory cannot be known (`git -C "$X" push`, `cd "$X" && git push`) in the session's own checkout: `?? dir` fell back to the cwd, so Jev was told the push went to the checkout's current branch (probe on this branch: `git -C "$X" push` -> `{ remote: null, branch: <the checkout's own branch> }`), and with no directory at all the callbacks got null. Now null like protectedPushOutcome reads it: no implicit destination, the remote not known to be local, explicit refspecs still named. RED: deny_rule_shapes.test.ts 19/20; GREEN 20/20.
  - Real bug, mod-skills hooks/index.ts:2376 (`e.input` on a `tool.call` event). Claude Code puts a tool's arguments on the event itself (`e.command` for Bash, claude-code.d.ts `ToolCallInput`); there is no `e.input`, so the measure-only hold rule never saw a failing test run. The hooks test sent `{ tool, input }`, the one shape the hook read and the engine never sends; it now sends the real shape. RED: hooks.test.ts "0.6.16 T4" 2/3; GREEN 3/3 (the hook passes `e`).
  - Annotation, mod-skills hooks/index.ts:766: the `$.state` contract (types/index.d.ts) lacked `'frontmatter'`, added to `SubagentEffortSource` in 0.6.16 T3; `parseRunningSubagents` already accepted it.
  - Annotation, gate-bash.ts:1408: `pluginVersion` is `string | undefined` on `BuildGateDecisionRecordInput` (still a required key); the builder already left the key out for undefined.
  - Annotation, gate-bash.ts:1623 and ab_benchmark_cli.ts:255: `buildActionGateState` returns a JSON object type instead of `Record<string, unknown>`.
  - Annotation, ab_benchmark_cli.ts:252: `decideAction` only ever returns allow or ask (every return checked); its return type is now `RiskGateDecision`.
  - Annotation, command_text.ts:335: the frame stack is `QuoteState` (readonly), never mutated in place.
  - Annotation, tool_decisions.ts:123 (x3, hooks environment, noUncheckedIndexedAccess): the ranked entry is read once into a local so the existing undefined check narrows it.
  - Not errors in the code (removed with the shim in T1): ab_benchmark_cli.ts argv x2 and exitCode, mod_skills_copy.ts digest.
  Tests, 32, all fixtures or annotations, no behaviour change: gate_measurement.test.ts x10 (the required `pluginVersion`/`stopReason`; the legacy record without them keeps its own explicit test), model_router_mode.test.ts x9 (`DEFAULTS: TierEffortMap`), policy_seed_import.test.ts x4 (fixtures typed `PolicySeedLike[]`), worktree_catalog.test.ts x2 (copy before `sort`), model_router_accounts.test.ts x2 (null checked before comparing ranks), activity_by_project.test.ts (the router fixture's required fields), model_router_stage.test.ts (a guard name that no longer exists, `sensitive-topic`, replaced by a real one; same assertion), gate_advice_retry.test.ts (an unused `@ts-expect-error`: the parameter is `unknown`), ab_benchmark_cli.test.ts (`env` typed `NodeJS.ProcessEnv` so `delete` is allowed), hooks.test.ts:2499 (an arrow returning a Map typed void). No `any`, no `as unknown as`, no `@ts-ignore`/`@ts-expect-error` added, no new cast.
  Replay against this branch's gate (live Jev, the owner's policies, scripts copied to the scratchpad's 0618/ and pointed at this worktree): 0.6.15's 244 rows 244/244, 214 refusals; 0.6.13's 38 rows 38/38, 22 refusals; 0.6.14's 10 rows 10/10, 6 refusals; 0.6.17 T1's 11 rows 11/11, 5 refusals; 0.6.17 T2's 16 rows 16/16, 11 refusals. Every row's outcome identical to the 0.6.17 run (0 changed); no refusal lost.
- [ ] T3 storage.json (and the decision on settings.json hook entries) protected
- [ ] T4 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- `npm run typecheck` exits 0 on the release branch, and CI runs it.
- Strict TDD for every behaviour change; `npm test` green; `npm run test:panels` green if a panel changes (it takes ~17 minutes).
- The 0.6.12–0.6.17 gate replay sets keep every refusal (T2 touches gate-bash.ts and deny_rule_shapes.ts).
- Privacy test exit code 0.

## Checks
`npm run typecheck`; `npm test`; `npm run test:panels` if a panel changes; `node --test scripts/private-data.test.mjs` (exit code); the replay scripts of 0.6.13–0.6.17.
