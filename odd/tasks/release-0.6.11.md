# 0.6.11: logs that never go silent, install in one step, full privacy, a calibrated router

Plane: JEVADV-80 (parent), JEVADV-62 (T1), JEVADV-71 (T2).

## Objective
Make 0.6.10 production-ready from what was measured on 2026-09-29 and from the
roadmap shown to the partner (share.onorca.dev/a/MUax4ZMJX3TV, section 06).

## Scope
- T1 Measurement logs never go silent (JEVADV-62). `$.fs.read`/`write` reject
  above 4 MiB and `appendToFile` rewrites the whole file. Seen live:
  `mod-tools-measurements.jsonl` stopped at 4,194,231 bytes at 17:28Z;
  `mod-skills-measurements.jsonl` is at 3.73 MB. Partition both per hour like
  `turn-usage-*.jsonl`; daily counts, readiness and the aggregators read across
  the partitions; the legacy single file is still read.
- T2 Install in one step (absorbs JEVADV-71, M5–M7): Node 24+ checked at run
  time, Orca accounts added after "Configure" connected, a doctor that runs the
  hook and names what is missing, hooks never left on an older copy.
- T3 Full privacy: repo, branch, worktree path, policies and `advisor.decide`
  pass through the same redaction as prompts and commands.
- T4 Confidence floor set from the record (142 of 389 held below 0.7).
- T5 Effort before model when an effort change is enough (model change drops
  the prompt cache).
- T6 Live quota from the status line input (5-hour and 7-day usage).

Out of scope: trimming tool results; gate bypasses A3–A8 (JEVADV-63..68).

## Checklist
- [x] T1 hourly measurement partitions, read across files (5baf81c; npm test 2498/2498, test:panels 155/155)
- [ ] T2 one-step install and doctor
  - [x] T2a hooks run an absolute Node >= 24 found at install time (not bare `node`
        from the GUI PATH); none found → status says `node: missing|too-old` with
        the version seen, and the config panel shows it (06c04b1; npm test 2518/2518; panel Node tests 20/20)
  - [x] T2b doctor executes each installed hook command with a harmless payload
        and names what failed; every hook's `pathMatches` counts, not only the gate (6afe09c; npm test 2532/2532)
  - [x] T2c M6: `install()` writes settings through `writeSettingsIfUnchanged`
        with the same retry as router-mode/steward (2b34b26; installer tests 55/55)
  - [x] T2d M7: install never deletes a mod-skills path it does not own; it
        reports the conflict instead (6352189; adapters/orca tests 282/282)
  - [x] T2e accounts added after Configure get connected: the worker re-scans
        `claude-accounts/` and installs on new ones (only once Configure has run),
        and re-installs when a hook points at a stale plugin root (9f34b9b; npm test 2545/2545)
- [x] T3 redaction of repo, branch, worktree, policies, advisor.decide (ca7d6f4, e9eb13f, d7daaa4, d185cab; command and prompt text through the same table 953a9d8, 93810a6; npm test 2581/2581)
- [x] T4 confidence floor from the record: kept at 0.7, one named `CONFIDENCE_FLOOR` (924b3b1; npm test 2581/2581)
  - Record: 472 router decisions, 2026-09-27..29; 388 at start/stage, 137 held by the
    low-confidence guard (was 142 of 389). Held if the floor were 0.5/0.6/0.7/0.8:
    111/157/196/236 decisions (confidence below it).
  - Ground truth: none. Records carry no session id; the only proxy (the next
    judgment of the same account and project within an hour, at confidence >= 0.8,
    proposing the same tier) agrees 48% at 0.9 confidence, 54% at 0.8, 50% at 0.7,
    53% at 0.6, 44% at 0.5: confidence does not predict agreement, and adjacent prompts
    legitimately differ, so it cannot say a hold was right or wrong. 3 days of data.
    No figure supports a change, so the floor stays 0.7. Revisit once decisions record
    the session and whether the person reversed the model.
- [x] T5 effort before model: dropped, reverted (0c2832a implemented it, reverted by the
  commit after it; router tests 218/218)
  - Premise false: jev-060-router.md §2.3 measured that an effort change rewrites the
    cache too (each effort level keeps its own cache past a shared ~12k tokens). Effort
    first would cost one rewrite and, when the model still has to move, a second, and
    it delays a quality upgrade by a turn.
  - Record: of 9 stage upgrades, 7 were Haiku to Opus (two steps), 1 Haiku to Sonnet (Haiku
    takes no effort): only 1 (Sonnet to Opus) was eligible, 1 of 25 applied stage model
    changes. No figure supports the change, so upgrades keep changing the model at once.
  - Kept from the same work (8f503a8): the status line no longer prints `(etapa: X)` on
    plain decisions (redundant with the model shown); kept models still say `(Jev: X)`.
  - Status line: `(etapa: X)` removed from plain decisions (it was Jev's tier for the
    prompt, redundant with the model shown); kept models still say `(Jev: X)`.
- [x] T6 live quota from `$.session.usage().rateLimits` (five_hour, seven_day: percentUsed, resetsAt), tighter-of-two band, `quotaSource` in the decision record; live figure dropped once its resetsAt passes, mirror fills a missing window while <= 30 min old (de5d377, 65402bf, 12de4d6; npm test 2575/2575; no panel touched)
- [ ] T7 README, release 0.6.11, live check on this machine (README and version done; npm test 2583/2583)

## Acceptance criteria
- A measurement log never stops recording, whatever its history size.
- A fresh install on a machine with Node < 24 says so in the panel.
- No repo name, branch or path reaches Jev in clear.
- Every threshold change is backed by a figure from the record.

## Checks
`npm test`, `npm run test:panels`, screenshots at 1440/768/390/320 in both
themes for panel changes (looked at), live check after release.
