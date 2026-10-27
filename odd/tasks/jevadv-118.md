# JEVADV-118: the router sizes a member's model to its brief, with a quality floor for code

## Objective
Use the model a task really needs, so tokens and the 5h/7d account limits last
longer, without lowering code quality (owner, 2026-10-27). Evidence from the
orca-oss lead: a read-only disk audit (ORCA-823) ran on Opus 5.5 · high while
harder code ran at medium.

## Finding (answers the ticket's open question)
Jev chose nothing for those members. Every Orca member starts with the prompt
"Read your Orca Lab brief at .orca/briefs/ctx_….md (task …) and follow it.",
which `isPointerPrompt` reads as a pointer (0.6.2 E6), so the `pointer-prompt`
guard held the session's launch model. From the local decision log
(`~/.cache/orca-supervisor`, 2026-10-20 to 2026-10-27): 231 member sessions,
206 started `held-by-guard | pointer-prompt`, 23 `held-by-orca-pin`. Only 17 of
116 member sessions since 2026-10-24 had any later `stage` row: a member's run
is one long turn, so the start decides it.

## Baseline (before), for the acceptance measurement
Member sessions since 2026-10-20 (start held by a pointer or an Orca pin), from
`model-router-decisions-*` and `turn-usage-*`:

| Measure | Value |
|---|---|
| Member sessions | 231 |
| Main and subagent steps | 8,804 |
| Median steps per session | 10 |
| Median output tokens per session | 11,300 |
| Median input tokens per session (input + cache read + cache write) | 991,699 |
| Total output tokens | 6,981,246 |
| Step mix | Opus 5.5 · high 2,386; Opus 5.5 · medium 2,375; Haiku 5.5 · high 2,185; Haiku 5.5 · xhigh 1,185; Haiku 5.5 · medium 401; Sonnet 5.5 · medium 260; Sonnet 5.5 · high 12 |

## Scope (lead, 2026-10-27: three PRs)
- PR 1 (T1, T2): Jev judges the brief, and a step-level floor raises a member
  that starts low as soon as it edits.
  - T1: a pointer to `<cwd>/.orca/briefs/*.md` (realpath inside it, a regular
    file, size cap) is resolved: Jev and the guards read only the text
    between `=== TASK ===` and `<<< PROJECT LESSONS` (the CLI part carries a
    live dispatch capability; the lessons are untrusted). A TASK that is only
    a ticket reference ("Work on X-1[: title]" and links) keeps the guard.
    Every other pointer keeps the E6 guard.
  - T2: on every main-loop step, an edit since the last prompt to a file in the
    worktree (not under `.orca/`, not outside the worktree: scratch, /tmp)
    while the model is below Opus 5.5 raises it to Opus 5.5 on the next step.
    So does an edited path in a high-risk area (security, credentials,
    migration, deploy, release, production). Never lowers; an Orca pin and a
    person's `/model` win.
- PR 2 (T3, T4, T5):
  - T3: review and design work join implement under the Opus 5.5 floor.
  - T4: "failing tests twice", RED-safe: a failing test run, then an edit to a
    non-test file, then a failing run again raises to at least Opus 5.5 and
    the effort one step (high to xhigh), never Fable (lead, 2026-10-27).
  - T5: quota-aware: near a 5h or 7d limit, only confident read or execute
    work shifts down; implement, review and design never do.
- PR 3 (T6, T7):
  - T6: the status line says who chose the model and why (Jev and the work
    kind, the code floor, an escalation, an Orca pin, the person). `orca game
    member` prints the pane's last 20 terminal lines, so the lead sees it.
  - T7: the acceptance measurement: per member session, tokens and 5h/7d use
    before and after, plus CI pass rate on the code PRs.

Out of scope: red CI and reviewer findings as escalation signals
(JEVADV-119, opened and linked 2026-10-27), releases, Orca's side.

Delivery (lead, 2026-10-27): the three PRs were split into six stacked PRs,
each at most about 400 non-test added lines and green on its own, merged in
order on main: T1 (brief), T2 (step floor), T3 to T5 (#103), T6 (status
line), T7 core (the measure), T7 CLI (the command, this file's measurement).

Lead's calls (2026-10-27): review subagents stay on Opus 5.5 under T3, and
T5 keeps the strong-economy band (quality first).

## Tasks
- [x] T1: RED: the Orca brief prompt resolves to its TASK text; the CLI part
  and lessons never reach Jev; a ticket-only TASK, a path outside
  `.orca/briefs`, a symlink out of the worktree and an oversized file keep the
  pointer guard. GREEN. Commit.
- [x] T2: RED: a session on Haiku that edits `src/a.ts` is raised to Opus 5.5
  at its next step; an edit under `.orca/` or outside the worktree is not; an
  edited high-risk path raises; an Orca model pin and a `/model` lock hold.
  GREEN. Commit. PR 1.
- [x] T3: RED: a `review` or `design` turn judged `simple` resolves to Opus
  5.5. GREEN. Commit.
- [x] T4: RED: fail, non-test edit, fail escalates; fail, test-only edit,
  fail does not; a pin holds. GREEN. Commit.
- [x] T5: RED: under economy a confident `read` turn shifts down a tier; an
  `implement` turn never does. GREEN. Commit. PR 2.
  Note: G4 stands (owner): the shift happens only at strong economy (>= 95%
  of the tighter window), standard to simple, after a read-only turn; T5 adds
  that the turn's kind must be a confident `read` or `execute`.
- [x] T6: RED: the status line names the reason. GREEN. Commit.
- [x] T7: measurement script and its numbers. Commit.

## Measurement (T7)
`npm run measure-member-routing -- --from <date> --to <date> [--json]` prints
the baseline table's measures for member sessions whose first start falls in
the window, plus member starts by class (pointer, orca-pin, brief),
escalations by signal and the CI pass rate per watch
(`ci-watch-decisions-*`). Re-run before the release (2026-10-20 to
2026-10-28, taken 2026-10-27): 234 member sessions, 9,981 steps, median
11,464 output tokens, starts pointer 207, orca-pin 27, brief 0, CI pass rate
66.7% (54 of 81 watches that ended). It is above the table because sessions
kept running after the snapshot. With the snapshot's cut, the start split was
206 pointer and 25 pin, not the 23 written above.

5h/7d use per session is not recorded: router rows carry only the account's
quota band, and `quota.json` is a live figure with no history. Recording it
is JEVADV-120 (opened and linked 2026-10-27). The "after" numbers wait for
the next Jev release, which needs the owner's OK, and a batch of members;
run the same command on a window after it.

## Acceptance criteria
- Red-first tests: a read-only audit gets a lower model or effort than a
  production-code task; a code task never goes below the floor; two failed
  test runs (RED-safe) escalate.
- The decision and its reason are visible in the member pane and in `orca game
  member` (its terminal tail).
- Measured on a real batch of members after a release (T7 holds the method and
  the before numbers; the after numbers need a release).
- An Orca launch pin always wins over the router.

## Checks
`npm run check` (typecheck, unit tests, panel tests, screenshots), run in the
background: it takes over 10 minutes.
