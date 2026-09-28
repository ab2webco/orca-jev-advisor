# Gate: keep identity arguments literal in the command shape (0.6.5)

## Objective

A cached gate verdict must never be reused for a command that targets a
different PR, issue, ticket, repository or push destination. Today the
command shape (the cache key's command part) replaces those identities with
placeholders, so `gh pr merge 12` and `gh pr merge 13`, or
`git push origin feature/x` and `git push origin main`, share one cached
verdict for 30 days, and the second command never reaches Jev.

Source: commit `bd986b3` on the old `fabolivark/gate-approval-learning-b2b`
branch, re-implemented on today's `src/core/command_shape.ts`. The old code
drifted too far to cherry-pick.

## Scope

- In: `src/core/command_shape.ts` and its tests; a bump of
  `GATE_DECISION_RULES_VERSION` so entries cached under the old shape stop
  matching; a gate-level test; README and version 0.6.5.
- Out: cache schema versioning (`0a4e233`), learnable/cacheable flags
  (`ea732af`), consequence confidence (`8513b39`). They are dropped: they
  plumb learning from human approvals, which the gate no longer asks for.
- Cleanup once this lands: delete the local branches
  `fabolivark/gate-approval-learning-b1b`, `-b2`, `-b2a`, `-b2b`, `-b3a` and
  the remote `origin/gate-approval-learning-b1`.

## Evidence (probe on 92b973e)

Pairs that shared one shape:

- `git push origin feature/x` / `git push origin main`
- `gh pr merge 12` / `gh pr merge 13`
- `gh pr merge 12 --repo acme/app` / `gh pr merge 12 --repo other/prod`
- `gh api repos/acme/app/pulls/3` / `gh api repos/other/prod/pulls/3`
- `glab mr merge 4` / `glab mr merge 9`

## Tasks

- [x] T1 `command_shape.ts`: keep PR/issue/MR/ticket numbers, sanitized URLs
      and owner/repo slugs literal for gh, glab and jira; keep every
      positional after `git push` literal. Tests first (RED on each pair
      above), then GREEN. Commands that differ only in harmless ways must
      still share a shape.
      Proof: RED -- the five pairs shared a shape and a `gh api -H` header
      value entered it as a verb; GREEN -- 26/26 in command_shape.test.ts.
- [ ] T2 Bump `GATE_DECISION_RULES_VERSION`; a gate test proves an entry
      cached for one identity does not serve another.
- [ ] T3 README "What changed in 0.6.5", version 0.6.5, full verification.

## Acceptance criteria

- Every pair above produces two different shapes.
- Secrets never enter a shape: URLs are sanitized (no userinfo, no query
  tokens), exactly as the old commit did.
- `npm test` and `npm run test:panels` pass; the private-data test passes.

## Checks

- `node --test src/core/command_shape.test.ts`
- `npm test`, `npm run test:panels`
