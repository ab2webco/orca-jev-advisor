# Release 0.6.23: each agent's worktree and branch in the agents band

## Objective
JEVADV-102. The agents band above the prompt shows, for each running agent, its type, its description, its model, its effort and the reason for that model. It should also show where the agent works: its branch, and its worktree when that is not the lead's. Asked for by the owner on 2026-10-01 ("Dale").

## Facts this rests on (checked in `adapters/claude/mod-skills/claude-code.d.ts`)
- `agent.spawn` input has `cwd?` ("undefined means the parent's") and the Agent call can carry `isolation?: 'worktree' | 'remote'`.
- `tool.call` input is `ToolCallEnvelope & AgentLoop`, and it carries `agentId` in a subagent. Each subagent's own tool calls can be attributed to it.
- `$.session.root()` is the session's project root, and "a shell `cd` during the session does not move it". The engine never reports a subagent's shell directory, so it has to be inferred.

## Field contract (shared by both writers)
Optional field on `RunningSubagent` (`src/core/subagent_status.ts`):

```ts
/** 0.6.23 (JEVADV-102): where the agent works; absent until known. */
readonly place?: AgentPlace;

export interface AgentPlace {
  /** The git worktree's top-level directory name (basename only), or null when unknown. */
  readonly worktree: string | null;
  /** The checked-out branch, or null for a detached HEAD or when unknown. */
  readonly branch: string | null;
  /** True when the worktree is not the lead's (`$.session.root()`'s top level). */
  readonly apart: boolean;
  /** `isolation: 'worktree'` was asked for and no path is known yet. */
  readonly pendingIsolation?: true;
}
```

- Rows are persisted and read back by `parseRunningSubagents`. Rows without `place`, or with a malformed one, still parse; the bad field is dropped.
- `AgentPlace` lives in `subagent_status.ts`. Writer B imports the type and never edits that file.

## Scope
- **T1 Where an agent works (writer A, branch `0623-agent-place`, worktree `orca-supervisor-0623-place`).**
  - A pure module, for example `src/core/agent_place.ts`, takes one tool call (tool name and arguments) plus the agent's base directory and returns the directory the call works in, or null.
    - Counted: Edit, Write and NotebookEdit `file_path` (its directory), Bash `cd <dir>` (alone or before `&&`/`;`) and `git -C <dir>`.
    - Not counted: Read, Grep and Glob. A writer told to read a plan in a sibling worktree must not move there.
    - Reuse `src/core/command_locations.ts` (`locateCommandSegments`) and the `~`/`$HOME` expansion idea of `gate_own_files.ts`. Do not add a new shell parser.
    - Relative paths resolve against the spawn `cwd`, or else the session root.
  - Resolution: from a directory, git `rev-parse --show-toplevel` and `branch --show-current`, through the existing process runner (`makeProcessRun($)`).
    - Cached per directory, recomputed only when the inferred directory changes.
    - Never run during the band render.
    - A failure or a detached HEAD gives `branch: null`; nothing throws.
  - Wiring in `adapters/claude/mod-skills/hooks/index.ts`:
    - Set `place` at `agent.spawn` from `cwd` (or mark `pendingIsolation`).
    - Update it from each subagent `tool.call` (by `agentId`).
    - Compute `apart` against the lead's top level.
    - The `tool.call` path must stay cheap and fail open: an error never blocks or delays the call beyond the cached git lookup.
  - Teammates: the same `tool.call` path applies when their calls carry an `agentId`.
- **T2 The band column (writer B, branch `0623-band-column`, worktree `orca-supervisor-0623-band`).**
  - `src/core/subagent_band.ts` draws the place in each row: the branch, preceded by the worktree name when `apart`.
    - `pendingIsolation` shows the localized word for "worktree".
    - No place means no column text for that row.
  - Branch prefix rule: drop a leading `word/` prefix only when every branch shown in the band, and the lead's branch, share it, the same way `sharedTypePrefix` drops shared type prefixes. Otherwise show the branch whole, cut from the left with `…` when it must shrink. Never a hard-coded user name.
  - No ambiguous-width glyph (`⎇`). Use plain text, counted by the band's existing cell width function.
  - Narrow widths give way in this order: the effort column, the reason's long wording, the place column, then the description.
  - i18n: any new word in es and en.
  - `scripts/screenshot-band.mjs` fixtures gain rows with a place: one row apart in another worktree, one row on the lead's worktree, and one pending isolation.
- **T3** Run `npm run shots:band` (200/120/80/40 columns, es/en, dark/light, 16 images) into `odd/qa/shots-0.6.23/`, and look at every image.
- **T4** README, CHANGELOG, version, QA in `odd/qa/qa-0.6.23.md`, release, live check.
  - Live check: a real Claude Code session in an Orca terminal (second account) in `/Volumes/Data/jev-live-check/feat-app`, with a second worktree of it on another branch.
    - One subagent `cd`s into the second worktree and edits a file there.
    - One control subagent works in place.
  - Read each row's `place` from the stored running-agents state.
  - What Claude Code paints is reported as terminal text (`orca terminal read`), not as an image, unless a real screenshot is taken.

## Checklist
- [ ] T1 agent place inference and resolution
- [ ] T2 band column
- [ ] T3 band screenshots, looked at
- [ ] T4 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD for each behaviour change (RED observed, then GREEN).
- `npm run typecheck` exits 0 and `npm test` is green.
- The gate replay sets pass unchanged.
- The privacy test exits 0. No user name, path or branch prefix is in fixtures or screenshots.
- Every band line fits `columns` at 200, 120, 80 and 40.
