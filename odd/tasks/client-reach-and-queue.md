# 0.6.7: the gate knows what reaches the client, and a person's approval never stalls an unattended agent

## Objective
A `requires_human` policy protects work that reaches the client. Today the
gate asks Jev whether a command "touches the client's product" from the
policy sentence alone, and Jev also flags work that never leaves the team
(pushing a work branch, opening a pull request in the team's repository,
replying to a review). Every ask blocks the agent until a person comes back.

1. Decide from facts whether a command stays inside the team, and never ask a
   `requires_human` policy about a command that does.
2. When a person must approve and nobody is watching, queue the action and let
   the agent continue with everything else, instead of blocking.

## Scope (authorized by the owner 2026-09-28: "Sí, arranca con 2 y 1")
- T1 Team repositories setting: a config panel field listing the repository
  owners (GitHub users/orgs) the team owns, stored and mirrored to the config
  dir like the catalog and policies. Empty by default: nothing changes until a
  person fills it.
- T2 `src/core/client_reach.ts` (pure): each command segment is `internal` or
  `unknown`. `internal` only for: segments tier 1a already calls safe; local
  git that never touches a remote; `git push` of a non-protected branch to a
  remote whose owner is a team owner; `gh pr create|view|checks|diff|comment|
  edit` (never `merge`) on a team-owned repository; `gh api graphql` whose only
  mutations are review-conversation replies/resolutions on a team-owned
  repository. Everything else is `unknown`.
- T3 Gate: when every segment is `internal`, `requires_human` policies are not
  put to Jev for that command (`prohibits` still are; local deny rules run
  first, as today). Recorded as its own stop reason.
- T4 Queue mode: a setting "When a person must approve: ask now | queue and
  continue" (default: ask now). In queue mode the first `requires_human` stop
  of a command in a session returns an advice-style deny telling the agent it
  is queued for a person, not to retry it or work around it, and to carry on;
  the item goes to `human-queue.jsonl` (command redacted). An identical retry
  in the same session asks normally: an agent only retries when the person,
  now present, tells it to.
- T5 Board: a "Waiting for you" list in the Gate tab from the queue (policy,
  project, what it would run, when), with how to release an item.
- T6 Subagents in sight (owner 2026-09-28: "Sí, mete la 1 en la 0.6.7"):
  the status line adds the running subagents and the model each one runs,
  and why it was kept (e.g. `agentes: 2 en Opus (pedido explícito)`); the
  board's Consumption tab counts subagent tokens apart from the main
  conversation. Visibility only: no decision changes.
- T7 A model fixed by an agent definition is judged, not pinned (owner
  2026-09-28: "también me gusta la idea que se pueda bajar el modelo si es
  mucho ... no porque esté fijo en algún lado"): `decideSubagent` may lower
  an explicit model under the same guards as any other decision (confidence
  floor, never below the session's model in a client's repository, failing
  or sensitive work) and only in the account's `active` router mode. A
  setting "Models fixed by an agent definition: judge them | keep them" in
  the Models tab, default "judge them".
- T8 README and release 0.6.7.

Out of scope: learning allows from approvals (a `requires_human` match is
never learned; JEVADV-12 design, D2); approving from the board (needs a write
path back from the panel; next release if the queue proves itself).

## Checklist
- [x] T1 team repositories setting -- Policies tab field, `teamOwners`
  storage key, mirrored to `team-owners.json`. RED seen (team_owners,
  store, team-owners-save, mirror, panel static and Playwright tests all
  failing first); GREEN: `npm test` 2311/2311, `npm run test:panels`
  145/145; Policies tab looked at, 1440/768/390/320, light and dark.
- [x] T2 client_reach classifier -- `src/core/client_reach.ts`, pure.
  RED seen (module missing; then a stale-facts gap: a `git remote set-url`
  or branch switch earlier in the same command); GREEN: 34/34 in
  client_reach.test.ts, `npm test` 2345/2345. `gh pr close`/`review`
  and read-only graphql stay `unknown` (conservative).
- [ ] T3 gate skips requires_human for internal-only commands
- [ ] T4 queue mode
- [ ] T5 board "Waiting for you"
- [ ] T6 subagents in the status line and the board
- [ ] T7 explicit subagent models are judged, not pinned
- [ ] T8 README and release

## Acceptance criteria
- With the team owner set, pushing a work branch and opening a pull request
  in a team repository pass without a `requires_human` ask; merging, pushing
  to a protected branch, publishing to a repository outside the team and
  changing repository settings still ask.
- With the setting empty, every decision is exactly as in 0.6.6.
- In queue mode an unattended agent is never blocked by a `requires_human`
  policy; the queued item is visible on the board; an identical retry asks.
- A queued command never runs without a person.

## Checks
- `npm test`, `npm run test:panels`; screenshots of the config field and the
  board list at 1440/768/390/320 in both themes, looked at.
- A live replay of real commands through the hook with the setting on and off.
