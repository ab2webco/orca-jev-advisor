# Release 0.6.28: the gate remembers delivery authorizations

## Objective
The owner, 2026-10-06, after the gate's own advice blocked the 0.6.27 QA merge:
- "Porque frena el merge victima de jev mismo jaja";
- "Aja pero no se guardan esas autorizaciones para decirle no puede ser posible que sigamos en lo mismo mejora esto y soluciona".

Earlier, they asked that agents in a harness never stop unless "lo que hagan pueda destruir".

Measured on 2026-10-06 from real transcripts (last 7 days, 35 project dirs; `scratchpad/mine_advise.py`):
- 1,605 advice blocks. The agent re-ran 1,174 of them (73%) unchanged: a paid turn each, for nothing.
- Delivery to GitHub, as blocked / re-run unchanged:

  | Action | Blocked | Re-run unchanged |
  |---|---|---|
  | Feature-branch push | 217 | 180 |
  | `gh pr merge` | 169 | 158 |
  | `gh pr create` | 87 | 82 |
  | `gh release create` | 63 | 60 |
  | Other `gh pr`/`gh api` | 61 | 54 |

- The gate log shows `policyId: null` on all 613 advised pushes and merges. The seeded `own_branch` / `own_pr_green` permits never reach the decision, so honouring them is not a fix.

Today the only memory is a 10-minute, per-session, exact-string retry (`src/core/gate_advice_retry.ts`). A new PR number, an added `&& git fetch`, or a new session blocks again.

## Design
- **Delivery classes.** These are non-destructive and recoverable:
  - `push-branch`: `git push` of a non-protected branch, with no force, no `+refspec`, no `--delete` and no `:ref`;
  - `pr-create`;
  - `pr-merge`: `gh pr merge` without `--admin`; the PR number is ignored;
  - `pr-update`: `gh pr edit|comment|review|ready`;
  - `release-create`.
- **Line rule.** A line qualifies only when every segment is obviously safe (the existing `isObviouslySafeCommand` segment logic) or belongs to a delivery class. Anything else (`rm`, `ssh`, heredoc writes, force push, `git branch -D`, protected branches) never qualifies.
- **Learning.** When the agent re-runs an advised line unchanged (the advice-retry pass), its delivery classes are recorded as authorized for the repo. The repo is identified by its normalized origin URL (`host/owner/repo`), so every worktree of one repo shares it; without a remote, the repo root path. Expiry is 30 days from the last use. The store is a file in the cache dir.
- **Use.** Only a risk advise (no policy) whose line qualifies, with every class authorized for the repo, becomes an allow. Jev's advice is still passed to the model as non-blocking context, and the log row says `stopReason: "authorized"`.
- **Untouched.** A `prohibits` or `requires_human` policy, the nine `NEVER_SILENTLY` rules and the local deny rules keep deciding as before.
- **Panel.** The panel lists the remembered authorizations per repo, with a way to forget each one (Rule 1).

## Out of scope
`rm`, `ssh`, heredoc writes and `--force-with-lease` keep today's advice. The Gentle AI line in `~/.claude/CLAUDE.md` is not touched.

## Checklist
- [x] T1 core: `deliveryClassesOf(command)`, line rule plus classes, with negative tests (`--admin`, `push --delete`, `:ref`, `+refspec`, `--force`, protected branch, `branch -D`, `rm`, `ssh`). Commit ed381d6. RED: 8 of 48 failing against a stub; GREEN: 48/48.
- [x] T2 core: authorization store (repo identity normalization, record, check with expiry, forget), pure, persisted by the adapter. Commit 247a86f. RED: 8 of 9 failing against a stub; GREEN: 9/9.
- [x] T3 hook: learn on the retry pass; turn a risk advise into an allow when authorized; a policy ask or deny is never relaxed (test). Commit a5d830e. RED: 3 of 9 subprocess tests failing; GREEN: 9/9. Full `npm test`: 3358/3358, typecheck 0.
- [ ] T4 panel and worker: list and forget, es/en, shots at 1440/768/390/320 in both themes
- [ ] T5 replay `advise_events.json` (blocks removed; zero `rm`/`ssh`/force/protected passes), docs, 0.6.28, release, catalog, live check

## Acceptance criteria
- Strict TDD: RED observed, then GREEN, per task. `npm run typecheck` 0, `npm test` green, `npm run test:panels` green.
- A second `gh pr merge <other number>` in the same repo, or in another worktree of it, passes without a block after one confirmation.
- A merge that matches a `requires_human` policy still asks, even with `pr-merge` authorized.
- Replay: zero `rm`, `ssh`, force-push or protected-branch events would pass.

## Checks
`npm run typecheck`, `npm test`, `npm run test:panels`, `npm run shots`, the replay script.
