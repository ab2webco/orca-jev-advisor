# Release 0.6.25: syncing a branch is not writing to it; the git policies refined on measurements

## Objective
JEVADV-104. The owner, 2026-10-02:
- "porque hacer pull esta bloqueado";
- "esos comandos son los que se usan para trabajar con git";
- "cambia esos textos y corrige para los demas usuarios";
- "refinalos con el aprendizaje y saca una version correcta".

An agent in a client checkout on main could not run `git pull`. It was refused under `never_write_to_main`, even after 0.6.24.

## Scope
- **T1 (writer, `0625-sync-effect`):** a `branch_effect.ts` fact for the forms that only sync the current branch with its own remote branch, and `GATE_DECISION_RULES_VERSION` 9.
- **T2 (lead):** refine the seed's `never_write_to_main` and `discard_uncommitted_work` on real-Jev measurements, and bump the seed to version 4 so existing installs are offered the change.
- **T3:** README, CHANGELOG, version, QA, release, live check.

## Checklist
- [x] T1 sync fact (53a94e3: RED at load, GREEN 11/11; npm test 3261/3261)
- [x] T2 refined seed texts, version 4 (RED 2, then GREEN 22/22; digest re-pinned)
- [ ] T3 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD; typecheck 0; npm test green; privacy 0.
- The six replay sets move no row beyond the 0.6.24 delta.
- Measured with real Jev in a checkout on main: sync commands pass, or at most get advice; writing commands stay refused by the policy.
