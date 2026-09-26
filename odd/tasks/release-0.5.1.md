# Release 0.5.1: stop asking about harmless commands, judge client work as client work

## Objective

Ship 0.5.1 so that a plugin user in `bypassPermissions` is no longer
interrupted for commands that harm nothing, while every command the gate
exists to catch still stops. Everything below is evidence from one real
machine running 0.5.0 on 2026-09-25, not a hypothesis.

## Problem (observed on 0.5.0, real machine)

- **Policy-stage false positives.** The policy stage asks Jev which policy
  covers the action and whether the action is "a concrete instance of what
  the policy covers, without judging whether it is allowed, forbidden or
  needs someone" (`src/core/decisions.ts:141`). A `prohibits` match is then
  treated as a violation (`interpretDestinationPolicy`). Commands that take
  a screenshot or write a heredoc match `visual_evidence` ("Nothing with a
  screen is called done without a screenshot…"), so the gate asks
  "Forbidden by visual_evidence" about the exact action that policy
  demands. Seen three times in one hour, once on the supervisor's own
  session. Five seeded policies describe how an agent works or what it
  claims, not anything a single shell command can violate:
  `visual_evidence`, `model_by_difficulty`, `delegate_by_scope`,
  `no_inventing_contracts`, `ticket_first`.
- **The stop reason is not recorded.** `gate-decision` records carry
  `type,id,at,project,commandFamily,source,verdict,latencyMs,pluginVersion`,
  and `gate-pending` records carry no policy id. Of 170 historical asks, 82
  have no risk scores. That set mixes policy stops, local-rule asks
  (`git push`, `curl | shell`, `git reset/clean`, `terraform`, `rm -rf`)
  and uncacheable commands, and today nothing can tell them apart. A fix to
  the policy stage cannot be measured without this.
- **Client work in sibling worktrees is not judged as client work.**
  Destination matching is a longest-prefix match on `worktreePath`
  (`src/core/destination_match.ts`). Orca worktrees live next to the main
  checkout, not inside it (`~/Projects/cineco-frontend-cin-985` next to
  `~/Projects/cineco-frontend`), so they never match their `client-site`
  destination. `client_always_asks` and the destination's context do not
  apply to real client work. This is the direction that matters: the gate
  is loosest where it should be tightest.
- **mod-skills can run active with zero calibration.** The hook reads the
  raw `active`/`activeTools` booleans (`adapters/claude/mod-skills/hooks/index.ts:133-142`)
  and never consults readiness. With `active:true` the real skill listing
  is withheld on every main-loop prompt, and when Jev picks nothing the
  model gets neither the listing nor a skill for that turn (`:183-192`,
  `:332-341`). The panel warns against it and the code does not enforce
  it. It was on, with 0 measurements, on this machine. Separately, the
  tool-relevance path calls Jev on every prompt with no sampling (`:350-457`).
- **Suite breaks without dev dependencies.** `scripts/fixture_shape.test.mjs:31`
  imports `screenshot-panels.mjs`, which imports `playwright` at top
  level, with no guard.
- **Policy seed notice reports noise.** `mergePolicySeeds` compares raw
  `kind` strings, so every install still carrying the legacy Spanish enum
  (`permite/prohibe/pregunta`) sees "20 differing" when 17 are functionally
  identical (`migratePolicyKind` already maps them at decision time).

## Why

The user asked for the next release to be tuned so that "this cannot
happen to plugin users" (2026-09-25), after being asked about harmless
commands several times in one session.

## Scope

In: tasks T1–T7 below. Out, documented for 0.6: the gate-approval-learning
chain (#29, B1b..C2), per-account model availability, mapping gateway
`resolvedModel` (`glm-*`) back to aliases for the match rate, widening
`REWRITE_PERMISSION_MODES` to `default`/`acceptEdits` (docs confirm Agent
never prompts and hook `allow` does not bypass deny/ask rules), readiness
reachability (E1) and per-direction confidence (E2).

## Constraints

- Local rules stay the floor. Nothing in this release may make a deny-tier
  rule, a `requires_human` policy or the risk stage more permissive. The
  one deliberate refinement is JEVADV-36: a destructive command in COMMAND
  POSITION still denies, and a mere MENTION inside a visible argument of an
  unknown program asks instead of denying. The person still decides, and
  it never becomes a silent allow.
- A policy without the new field keeps today's behaviour (`command`). A user
  rule is never silently dropped.
- Privacy rule of `gate_measurement.ts` holds: record ids and families,
  never the command.
- Artifacts in English. No `any`, no `console.log`/`debugger`, no mocks in
  production code. Tests and docs travel with each fix.
- Branch `fabolivark/release-0.5.1` from `main` at `19e9873` (v0.5.0).

## TDD

- Mode: strict TDD **on**. Source: `~/.claude/CLAUDE.md` ("Strict TDD Mode: enabled").
- Runner: `npm test` (`node --test --experimental-strip-types`), full
  gate `npm run check` (suite + panels spec + screenshots).
- Each task starts with an observed RED.

## Tasks

Tracked on Plane, private project `JEVADV` (workspace ab2web), module
"0.5.1 — release hardening". Mapping: T1=JEVADV-2, T2=JEVADV-1,
T3=JEVADV-3, T4=JEVADV-4, T5=JEVADV-5, T6=JEVADV-6, T7=JEVADV-9, with
JEVADV-7 (replay bench), JEVADV-8 (naive-agent scenario), JEVADV-10
(locale) and JEVADV-11 (catalog gaps) in the same module. Module "0.6 —
evolution" holds JEVADV-12..23.

- [x] **T1 — Record why the gate stopped.** Done in `49d249d` (delegated
  writer). Vocabulary: `local-rule`, `cache`, `policy`, `risk`, `unreachable`.
  Split on `GateActionResult.policyId`. Add a `stopReason`
  (`policy` | `local-rule` | `risk` | `unreachable` | `cache`) and, for
  policy stops, the `policyId` to `gate-decision` and `gate-pending`
  records. Ids only. Route: delegated writer (2+ non-trivial files).
- [x] **T2 — Process policies never gate a command.** Done in `60dab61`
  (delegated writer). Seed version 2. `cmdDecide` in `main.mjs`, which
  judges free-text task actions rather than shell commands, keeps every
  policy on purpose. `Policy.scope?:
  "command" | "process"`. Filter `process` before `buildPolicyQuestions` so
  those rules never enter the coverage criteria. Mark the five process
  policies in `seed/policies.json` and bump the seed version. For a stored
  row without the field: use the seed's scope for that id, else `command`.
  Route: delegated writer.
- [ ] **T3 — Sibling worktrees match their repository's destination.**
  When the cwd's worktree is a linked worktree, resolve its main checkout
  (`.git` file → `gitdir:` → `<main>/.git/worktrees/<name>`) and match the
  catalog against the main checkout too. A nested path match still wins
  over a sibling match. Route: delegated writer.
- [ ] **T4 — mod-skills never hides skills it did not replace.** Keep the
  real listing whenever no skill is injected, and sample the tool path the
  same way as the skill path. Route: delegated writer.
- [ ] **T5 — Suite runs without playwright.** `fixture_shape.test.mjs`
  skips cleanly when `playwright` is absent. Route: inline (one file).
- [x] **T6 — Seed notice compares normalized kinds.** Done in `648e508`
  (delegated writer). Compares the migrated kind and the resolved scope.
- [x] **T8a — Review correction R3 (inline, 45ad820).** A double-quoted
  `$(…)`/backtick was opaque to the force-push rule, which is a deny-tier
  bypass introduced by T8. Bodies are now spliced back in per token, after
  tokenizing. RED/GREEN, 2063/2063.
- [ ] **T10 — Quoted text opaque only in known data positions (JEVADV-28).**
  Review follow-ups: ssh/su -c/python -c/watch/script -c commands must stay
  visible; `git checkout main --` allowed; an unknown policy scope resolves
  as command instead of dropping the row; fix the misleading comment and
  the function name. Blocks the release.
- [ ] **T11 — Pending baseline policy updates stay visible (JEVADV-27).**
  Worker/panel side, so it needs a plugin reload to verify.
- [x] **T8 — Deny tier ignores quoted data (JEVADV-24).** Done in
  eab080a, dd7975f and 44862a3; reopened by T10. Observed live:
  a `printf` whose double-quoted text spelled out a hard reset was refused
  as "discards uncommitted work". Quoted strings and heredoc bodies must be
  opaque to the deny rules; `$(…)`, `bash -c` and `sh -c` stay scanned.
  Route: delegated writer.
- [x] **T9 — Leading env assignment leaks into commandFamily (JEVADV-25).**
  Done in 37b972f.
- [ ] **T7 — Release.** Version 0.5.1, README and changelog, `npm run
  check` with screenshots at 1440/768/390/320 in both themes, then the
  real-machine verification below.

## Acceptance criteria

- A command that writes or takes a screenshot, run in any catalogued
  destination, is no longer stopped by `visual_evidence` or any other
  `process` policy.
- Every stop recorded after 0.5.1 carries a `stopReason`. Policy stops
  carry the `policyId`.
- A command run in `~/Projects/cineco-frontend-cin-985` resolves to the
  `cineco-frontend` destination.
- With `active:true` and a Jev pick of none, the model still receives the
  full skill listing.
- `npm test` passes with `playwright` moved out of `node_modules`.
- Deny-tier matrix unchanged: `git reset --hard`, `git checkout -- <file>`,
  force push, `rm -rf` of `/` or `$HOME`, `DROP TABLE`, `curl | bash`,
  `terraform apply/destroy`, `kubectl delete` are refused exactly as in 0.5.0.

## Real-machine verification (before tagging)

1. Load the branch through Orca's plugin **Desarrollo** section, then run
   `node adapters/orca/install-claude-integration.mjs status <root>`: 5/5
   targets with hook, outcomeHook, agentModelHook, env, modCopy.
2. Replay bench: a local-only corpus of realistic developer commands, drawn
   from this machine's own agent transcripts and never committed, run
   through the real hook before (0.5.0) and after (branch). Compare the ask
   rate per `stopReason`.
3. A fresh supervised agent with no context runs a realistic developer
   scenario in a sandbox project with a local bare remote (npm, TypeScript,
   tests, git flow, subagents, plus the deny-tier commands confined to the
   sandbox). Every prompt it hits gets recorded verbatim.
4. Evidence in `~/Downloads/jev-advisor-verificacion-0.5.0/`.

## Worktree and scratch hygiene

Every worktree or scratch directory created for this feature is listed here
and removed when its purpose ends. Pre-existing ones that belong to other
work (`gate-approval-learning/`, `../orca-supervisor-release`) are not
touched.

| Path | Branch | Purpose | Remove when |
|---|---|---|---|
| `../orca-supervisor-next` | `fabolivark/release-0.5.1-next` | Writer lane A | Its last batch is merged: remove the worktree, delete the branch |
| `../orca-supervisor-lane-b` | `fabolivark/release-0.5.1-panel` | Writer lane B (JEVADV-27/10/11) | Merged: remove the worktree, delete the branch |
| `../orca-supervisor-lane-c` | `fabolivark/release-0.5.1-modskills` | Writer lane C (JEVADV-4) | Merged: remove the worktree, delete the branch |
| `../orca-jev-advisor-dev` | detached | Dev plugin loaded in Orca | After the release, once the person switches Orca back to the marketplace plugin |
| `~/Projects/jev-sandbox-app`, `~/Projects/jev-sandbox-remote.git` | none | JEVADV-8 scenario | When the scenario report is recorded |

## Delivery

- Forecast: about 800 authored lines across T1–T7, over the 400 budget.
  Strategy: `ask-on-risk`. Chain strategy: pending the user's choice.

## Progress

- 2026-09-25: branch created at `19e9873`. Config on the real machine
  corrected: mod-skills switched off (`~/.config/orca-supervisor/mod-skills-config.json`,
  the only writer is the panel request path, activation only reads it).
  Models catalog verified correct for the four accounts: fable
  `available:false` (one account without Fable quota, z.ai maps no fable
  alias), opus/sonnet/haiku `true` (z.ai maps them to glm-*), `active:false`.

- 2026-09-25: T1, T2 and T6 committed. Parent spot check with
  `env -u ORCA_USER_DATA_PATH npm test`: 2012 tests, 2012 pass, 0 fail.
  Dev plugin loaded in Orca from `~/Projects/orca-jev-advisor-dev`, a
  detached worktree advanced only to verified commits. `status`: 5/5
  targets pointing to it.
- Replay baseline on 0.5.0 over a 300-command stratified sample of real
  local traffic: allow 182, pass 11, ask 65, deny 42. About 49 asks come
  from the risk stage and 16 from policies (client_always_asks 6,
  others_pr 5, large_pr 3, visual_evidence 2).

- 2026-09-25: native review (RDD on, consent granted by the user). Lineage
  `review-035d390361bfd3ef` covers `19e9873..45ad820` with 4 lenses. One
  CRITICAL finding (R3) was fixed in one bounded correction and passed the
  targeted validator; the review was approved and acknowledged, authority
  burned. The advisory findings became T10. The dev plugin runs at `45ad820`.
- Replay after T8: 17 deny-tier verdict changes, each reviewed by hand. 12
  quoted-data false positives are gone, and 5 real `git reset -q --hard`
  cases that 0.5.0 missed are now refused.
- JEVADV-26 measured: consequence noise σ = 0.039. A 3σ margin (0.12)
  catches 22/22 flip-allows at a cost of 10/105 stable allows in a
  risky-family sample. It is being implemented in the isolated worktree
  `../orca-supervisor-next` together with T5 and T3.
- Worker-side changes take effect only after the plugin reloads. Hook-side
  changes take effect on the next command.

- 2026-09-25, later in the day. Native reviews 2 (`review-3ca73b9da09b0927`)
  and 3 (`review-4c988dc5b95e74e7`) were approved and acknowledged. Merged
  since then:
  - JEVADV-28 (7a64807) and JEVADV-34 (7cf2c47)
  - JEVADV-35 (209c861): the cache key carries the decision-rules version;
    the cache TTL is 30 days
  - JEVADV-29 (42cc829): secrets masked before the Jev call
  - JEVADV-36 (609e34b)
  - JEVADV-29 precision (4d5ebe2)
- Suite on the branch files: 1206/1206 with playwright. Wrapper probe: 10/10.
  Compared with 0.5.0, `env A=1 <hard reset>` goes from pass to deny and
  `echo "$(<force push>)"` from ask to deny.
- Lanes B (panel, JEVADV-27/10/11) and C (mod-skills, JEVADV-4) run in
  isolated worktrees. Lane D (JEVADV-8) is a context-free supervised agent
  running the realistic scenario on the live dev plugin, held at 42cc829
  until it finishes.

## Next step

Native review of `7cf2c47..HEAD`. Then merge lanes B and C, finish the lane D
report, and do the release verification (JEVADV-7/9).
