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
- [ ] T1 typescript, tsconfig, `npm run typecheck` in check and CI
- [ ] T2 every type error fixed; real bugs with a failing test first
- [ ] T3 storage.json (and the decision on settings.json hook entries) protected
- [ ] T4 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- `npm run typecheck` exits 0 on the release branch, and CI runs it.
- Strict TDD for every behaviour change; `npm test` green; `npm run test:panels` green if a panel changes (it takes ~17 minutes).
- The 0.6.12–0.6.17 gate replay sets keep every refusal (T2 touches gate-bash.ts and deny_rule_shapes.ts).
- Privacy test exit code 0.

## Checks
`npm run typecheck`; `npm test`; `npm run test:panels` if a panel changes; `node --test scripts/private-data.test.mjs` (exit code); the replay scripts of 0.6.13–0.6.17.
