# Clef decides policy commands, and every surface names the decider

## Objective

In "both" mode, Clef answers every gate decision, including commands that a policy applies to, until Clef's daily neuron budget is spent. After that, Jev answers as it did before. The point is to use both credits. Wherever a gate decision is shown, it says who decided: Clef or Jev.

## Why

On 2026-10-17 the owner reported two problems:
- With Clef deciding, the notices still said "jev".
- The board showed every decision as Jev's, so there was nothing to compare.

**What the log showed:**
- Since the policies were restored at 06:49Z, about 800 of about 800 decisions were `jev/policy` and Clef answered none.
- The cause is `skipClef: commandScopedPolicies.length > 0 ? 'policy' : null` in `adapters/claude/gate-bash.ts`. With 23 policies, almost every command has one.
- Every gate line in `src/core/i18n_gate.ts` starts with `jev ·`, whoever decided.

## Measurement behind the escalation rule

The measurement replayed 56 real commands against the owner's 24 policies (scratchpad `clef-policy/out/summary.txt`). The rules it tried:

| Rule | Sent to Jev | Verdict diffs vs Jev |
|---|---|---|
| Doubt only (drop `skipClef`) | 36% | 3, including a missed `never_write_to_main` deny. Unsafe |
| Clef's max non-none probability on `violation` or `needs_person` ≥ 0.5 | 48% | 1 |
| Clef's max non-none probability on `violation` or `needs_person` ≥ 0.2, plus doubt, failure and timeout | 57–62% | **0** |

The release uses the ≥ 0.2 rule because it is the only one with zero verdict changes. Clef decides the rest, which is about 40% of policy commands. Measured cost is about 50 neurons per call, so the 9,000 stop covers about 180 calls a day; Jev answers the rest.

## Scope

- **Routing.** In both mode, a decision with command-scoped policies goes to Clef first. It escalates to Jev with escalation `policy` when Clef's answers give a non-none choice on the policy questions (violation, needs_person, whatever the gate's policy question ids are) a probability of 0.2 or more. Doubt, failure, rate limit, budget and timeout escalate as today. Jev-only and Clef-only modes do not change.
- **Attribution.** Every surface that shows a gate decision names the provider that decided it:
  - the user-facing gate lines (es and en);
  - the model-facing hook text, such as "Jev advice", "Jev advice (not a refusal)" and REFUSED texts;
  - reason strings that name Jev as the judge;
  - the board's recent decisions;
  - any notice that says Jev decided.

  In Jev-only mode the text stays exactly as it is today.
- **Board.** The provider card already exists. Its copy must stay true under the new routing: "Preguntas de política enviadas directo a Jev" becomes "Clef saw a possible policy hit; Jev answered" or similar.

## Checklist

- [x] C1 Routing: policy commands go to Clef and escalate on the ≥ 0.2 policy-question rule (RED: a both-mode decision with a policy and a clean Clef answer is answered by Jev)
- [x] C2 Attribution in gate lines and model-facing text follows the provider (RED: a Clef-decided advise or deny line says "jev")
- [x] C3 Board copy for the `policy` escalation matches the new meaning; every other surface audited for "Jev decided" wording
- [ ] C4 Release 0.13.4: CHANGELOG, README block, version bump, release, catalog, live check, `odd/qa/qa-0.13.4.md`

## Acceptance

- In both mode with policies, decisions show `provider: clef` when Clef's policy probabilities are under 0.2 and there is no doubt, and `jev/policy` otherwise.
- When Clef decided, its gate line and its model-facing text name Clef. When Jev decided, they name Jev.
- `npm test`, `npm run test:panels` and `npm run typecheck` pass.
- Live: after the owner updates, today's `gate-decisions` rows show Clef decisions on policy commands, and the board's split is no longer 0 Clef.
