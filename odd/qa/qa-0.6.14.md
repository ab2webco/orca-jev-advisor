# QA 0.6.14: one row per running agent, string literals as data, empty-catalog hint

Run 2026-09-30 against the 0.6.14 release branch rebased on 989d73e
(working-tree hook `adapters/claude/gate-bash.ts`, real team policies, live
Jev). Scratch repositories under `/Volumes/Data/jev-live-check/` (`SCR`), as
in odd/qa/qa-0.6.13.md.

## Summary

| Check | Scenarios | Pass | Fail | Notes |
|---|---|---|---|---|
| `npm test` | 1 | 1 (2795/2795) | 0 | after the rebase |
| Replay of the 0.6.12 rows | 244 | 243 | 1 | identical to 0.6.13; the 1 is N-06 (local remote, near the gate) |
| New rows of 0.6.13 | 38 | 36 | 2 | N23/N24, N-05 (`requires_human` on topic), 0.6.15 |
| N-09 probes: a call only quoted vs a real call | 10 | 10 | 0 | below |
| Agents band, painted from the hook's own tree | 16 images | looked at | | 200, 120, 80, 40 columns; es/en; dark/light |
| Models tab, empty catalog | 24 images | looked at | | 1440, 768, 390, 320; light/dark; never seeded (es, en) and emptied (en) |

## N-09: a call quoted inside a string is data

| Row | Command (in `SCR/feat-app`) | Expected | Result |
|---|---|---|---|
| P01 | a `python3 - <<'EOF'` that writes a table row quoting `os.system('git push --force …')` and `git push --mirror` into a file | not refused | allow |
| P02 | a `node - <<'EOF'` that writes a string quoting `execSync('rm -rf ~')` | not refused | allow |
| P03 | a Python comment naming the force push, then `print` | not refused | allow |
| P04 | a JS template literal holding the call's text | not refused | allow |
| P05 | `os.system('git push --force origin x')` as code | refuse | `REFUSED` force push |
| P06 | `x = os.system('git push --force origin x')` | refuse | `REFUSED` force push |
| P07 | `subprocess.run(['rm', '-rf', '/'])` | refuse | `REFUSED` recursive delete |
| P08 | `require('child_process').execSync('rm -rf ~')` | refuse | `REFUSED` recursive delete |
| P09 | perl backticks with a force push | refuse | `REFUSED` force push |
| P10 | ruby `system('git push --force origin x')` | refuse | `REFUSED` force push |

P01 is the command 0.6.13 refused twice in the release session (qa-0.6.13
N-09). K-py-heredoc-force, N28 and N30 of qa-0.6.13 are still `REFUSED` in the
replay and the new rows.

## Agents band

`npm run shots:band` (scripts/screenshot-band.mjs) runs the real hook's
render function and paints its tree cell by cell, for the owner's case: four
agents, two of the same type told apart by their task, one with no record
("sin datos: empezó antes de recargar el plugin"). Looked at: all 16 images
in `odd/qa/shots-0.6.14/band-*`. At 200 and 120 columns every column shows;
at 80 the effort column is dropped and long texts end in "…"; at 40 each
agent takes two lines. This is the hook's tree, not Claude Code's own paint:
that is the live check below.

## Models tab

`models-empty-*` and `models-emptied-*` in `odd/qa/shots-0.6.14/`. Looked at
1440 and 320 in the lead's review, all 24 by the writer: on a never-seeded
empty catalog the tab names Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku
4.5 and the two log lines to look for; an emptied catalog keeps the old text;
no overflow at 320.

## Open findings

- N-05, N-06, N-07, N-08 of qa-0.6.13 are unchanged (JEVADV-84, 86).
- **N-10 low (0.6.15).** Python f-string `{…}` expressions are read as text,
  so a call placed inside one is not seen (reported by the writer).
- **N-11 low (0.6.15).** Advice (not a refusal) on `node - <<'EOF'` edit
  scripts: `const fs = require("fs")` was read as a command the heredoc runs.
  Same family as JEVADV-83.

## Live check after the release

Released v0.6.14 (d9f2829, PR #18); the dev copy pulled to it, and all five
installed mod copies (`~/.claude` and the four Orca accounts) carry
`src/core/subagent_band.ts`. A real Claude Code session (Sonnet 5.5, a second
Orca account) in `SCR/feat-app` launched four background agents in one
message:

| # | Type | Task | Model asked | Router decision (model-router log) |
|---|---|---|---|---|
| 1 | general-purpose | Count lines in math.js | opus | `explicit-lowered`, applied (Jev lowered it) |
| 2 | general-purpose | List recent commits | none | `switch`, applied (chosen by Jev) |
| 3 | Explore | Find the test files | none | `switch`, applied (chosen by Jev) |
| 4 | general-purpose | Check the git status | haiku | `explicit`, kept |

All four ran and reported. Another session of the owner's printed the
reload notice with `ui.render` among the mod's hooks, so the band hook is
registered.

**Not looked at: the band as Claude Code paints it.** The test session's tab
was behind the owner's working session, and the lead did not switch the
owner's window. The rows were seen only in the hook's own tree painted by
`npm run shots:band` (above). JEVADV-88 stays open until the live band is
looked at.
