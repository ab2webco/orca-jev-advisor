# JEVADV-112: withhold the skill listing when nothing fits

## Objective
Stop carrying a 34k-character skill listing on prompts where no skill fits.
Baseline (owner's machine, 2026-10-15 to 10-22, 740 sessions): 4,878 skill
decisions, listing 33,924 characters median (~8,500 tokens), 65 candidates;
3,478 (71%) nothing fits, 1,223 recommended (listing withheld), 115 no skill
needed, 62 Jev did not answer; 11 skill uses observed afterwards.

## Measurement first (2026-11-14)
Question: does withholding remove the listing from every later step, or only
the first one?

**Answer: from every later step and every later turn of the session. And a
withhold only works on the turn that carries the listing, which is the
session's first.**

- The engine's contract (`claude-code.d.ts`, `prompt.attachment`): "The answer
  holds per attachment for the process (asked again on resume or
  `$.ui.invalidate`)." A `{ text: null }` stays in force for every request
  that carries that attachment row.
- The transcripts (`npm run measure-skill-listing`, 14 sessions of this
  machine's three accounts, 17 to 219 user rows each): every session has
  exactly **one** `skill_listing` row, `isInitial: true`, in its first turn.
  No later prompt carries a listing. Median 21,716 listing characters (38 to
  39 skills), re-read by a median **89** main-loop requests, so about
  **483,000 listing tokens per session**.

What this changes:
- The ticket's formula (3,478 prompts x 7.4 steps x 8.5k = 219 M) has the
  wrong shape. The listing is not sent per prompt. A withhold on a later
  prompt keeps out nothing, because no listing is being asked about then.
  A withhold on the first prompt keeps it out of the whole session.
- Corrected estimate: sessions whose first prompt is well below the bar x
  8.5k tokens x requests carrying the listing (median 89 here). At the
  baseline's 740 sessions a week, each such session saves about 0.76 M
  re-read tokens; if the 71% nothing-fits share held for first prompts, about
  **400 M a week** (upper bound: "well below" is a subset of "nothing fits",
  and member sessions with a few prompts dominate this sample). These are
  cache reads, not fresh input.
- The 1,223 "recommended, listing withheld" decisions mostly withheld
  nothing: only the ones on a session's first turn did. The board's "Listing
  characters not sent" summed every one of them; it now counts the real
  withholds (see below).
- The risk is larger than per prompt: a withheld listing is gone for the
  session, so a later prompt that needs a skill reaches it only through
  active mode's own injection (or the person typing `/skill`). That is why
  the bar is well below the threshold, and why missed skills are recorded.

Still to confirm on the owner's machine (no Jev Advisor install here, so no
mod-skills or turn-usage rows): the share of first prompts below the bar,
and that a compaction re-sends the listing (no compaction in this sample).
Both read from `npm run measure-skill-listing` after a week of the new rows.

## Work
- [x] `nothingFitsWellBelow` (`src/core/skill_decisions.ts`): Jev answered
  both stages, the gate said a skill may be needed, and every `fits` is below
  `withholdBelow` (default 0.15, half the 0.3 fits threshold). A best fit
  from 0.15 to 0.3 keeps the listing, though nothing is suggested.
- [x] Active mode withholds the listing on such a decision, with nothing
  injected. Measurement mode only records `nothingFitsWellBelow`. The option
  `withholdBelow: 0` turns it off.
- [x] Decision rows carry `withholdReason` (`skill`, `nothing-fits` or null).
  A `listing` row records what the session's listing actually was (chars,
  withheld and why, session id, decision id), written only on a turn with a
  decision. A `withheld-use` row records every skill loaded while the
  session's listing is withheld: the missed-skill count.
- [x] The board's "Listing characters not sent" counts `listing` rows for new
  decisions; older rows keep their count. The aggregate adds
  `listingsAsked`, `listingsWithheld`, `listingsWithheldNothingFits` and
  `skillUsesAfterNothingFits`.
- [x] The board's Modules tab shows, per window, "Sessions without the
  listing: no skill fit" and "Skills used anyway" once listing rows exist
  (read at 1440, 768, 390 and 320, light and dark).
- [x] `npm run measure-skill-listing`: listing rows per session and requests
  re-reading them from transcripts, and tokens kept out and skills used after
  each withhold from the mod's rows.

## Acceptance
- Saving: corrected above (per session, not per prompt); the week's figure
  comes from `npm run measure-skill-listing` on the owner's machine.
- Missed skill uses do not rise: `skillUsesAfterNothingFits` against the
  baseline's 11 skill uses a week.
- orca-game: the change only answers the engine's `skill_listing` attachment
  for the main conversation and appends rows to the cache directory. It reads
  nothing from a pane and writes nothing to one, the status line and the
  `advisor` value are unchanged. A lead pane starts with a slash command
  (`/orca-game:lead`), which makes no decision, so its listing goes through.
  A member's first prompt is the Orca brief, judged like any prompt: if no
  skill comes near, the member runs without the listing. Live check in a lead
  and a member pane not done here (no install on this machine).

## Follow-ups (release QA on the owner's Mac)
- [ ] Live check in an orca-game lead pane and a member pane (`game launch`
  with a no-op prompt): the Panel, the member band and the HUD keep working.
- [ ] After a week of the new rows, `npm run measure-skill-listing`: the
  share of first prompts withheld for nothing-fits, the tokens kept out, and
  `skillUsesAfterNothingFits` against the baseline's 11 skill uses; confirm
  that a compaction re-sends the listing.
