# Release 0.6.20: agent-team teammates seen and routed

## Objective
On 2026-10-01 the owner restarted Claude Code and ran an agent team. Its teammate showed on the agents band with model and effort `? ?` and the reason "sin datos: empezó antes de recargar el plugin". The router decision log has no `subagent` row for it and turn-usage has no step from it: the plugin never saw the teammate, so it assigned no model or effort. The band's reason was a guess, and here it was false.

The goal: every agent the band lists shows its real model and effort and the true reason. Teammates are routed like subagents wherever the engine lets a plugin do it.
Authorized by the owner 2026-10-01 ("Arregla esto").
Plane: JEVADV-99.

## Scope
- T1 The probe's facts. A throwaway-plugin probe records which plugin events a teammate's creation and steps fire, with their fields: `agent.spawn`, `turn.step` with `agentId`, and `$.agent.list()` type `teammate` with its model. Record the result in this file. It decides T3.
- T2 The band tells the truth, whatever T1 finds.
  - For an agent the plugin did not see at spawn, the band reads what the engine reports: the model from `$.agent.list()` or from the agent's own `turn.step` / `turn.complete`, and the effort from its first step, as 0.6.15 T4b already does for subagents.
  - The reason says what is known:
    - for a teammate: "teammate: created outside the router";
    - for an agent seen only after a plugin reload, when that can be told (for example, it started before this hook process): "started before the plugin loaded";
    - otherwise: "not seen at launch".
  - Never guess a reload.
  - es and en text. Band screenshots at 200/120/80/40 columns, es and en, both themes, every image opened.
- T3 Route teammates, as far as the engine allows (from T1).
  - If `agent.spawn` fires for a teammate: route it like a subagent. That covers the tier judgment, the work kind and caps (0.6.16 T2, under its switch), the definition floor and a decision row with `agentId`.
  - If only `turn.step` reaches its loop: decide at the teammate's first step (the same Jev call and rules as at spawn) and apply the model and effort through `turn.step` from then on, with the same guards. Log a decision row with `point: "teammate"`.
  - If neither does: no routing. The README says so plainly, and the band reason says "created outside the router".
- T4 README (latest "What changed"), CHANGELOG, QA in `odd/qa/qa-0.6.20.md`, release, live check with a real agent team.

## Checklist
- [ ] T1 probe facts recorded
- [ ] T2 band shows the real model, effort and reason for agents not seen at spawn
- [ ] T3 teammates routed as far as the engine allows
- [ ] T4 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD for each behaviour change.
- `npm run typecheck` exits 0 and `npm test` is green.
- `npm run test:panels` is green if a panel changes.
- No change to how ordinary subagents are routed. The 0.6.16 hook tests stay green.
- The privacy test exits 0.
