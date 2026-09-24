# Checkpoint — read this first

Handoff for whoever picks this up in the Orca worktree
`orca-supervisor/gate-learning-cache-and-deny-threshold`, branch
`feat/gate-learning-cache-and-deny-threshold`, cut from `65480ed`.

The conversation that produced this is long. Everything below was measured or
read out of the code in that session; nothing here is assumption. Where
something is unverified it says so.

---

## The sentence that governs every tradeoff

> **The model does not decide to delete anything. The system decides.**

The user's words, after a `git checkout -- <file>` in that session discarded
uncommitted work that an agent had just written. This is a plugin people run
in critical environments; it has to hold.

Three invariants follow. No optimisation may break them:

1. **Local rules are the floor.** No network, no key, no threshold. Jev was
   unreachable for ten minutes during that session. Nothing we build may
   depend on Jev answering.
2. **The threshold is ours, the number is Jev's.** Jev measures; we compare.
   That is already true (`src/core/decisions.ts:525`) and stays true. We are
   adding the branch that was never written, not handing Jev authority.
3. **The cache may never turn "I don't know" into "go ahead."** A shape whose
   score lands near the threshold does not settle on one observation.

---

## Why we are doing this: the incident, in full

Three failures lined up and a destructive command ran unjudged.

**One — the deny rule has a hole.** `adapters/claude/gate-bash.ts`,
`NEVER_SILENTLY`:

```js
{ pattern: /git\s+(reset\s+--hard|clean\s+-[a-z]*f)/, why: 'rule.resetClean' }
```

It covers `git reset --hard` and `git clean -f`. It does NOT cover
`git checkout -- <path>`, `git checkout .` or `git restore <path>`, which
discard uncommitted work exactly the same way and have no reflog behind them.
The family classifier misses them too — measured:

```
"git checkout -- <file>"  -> git            (not "git reset/clean")
"git restore <file>"      -> git
"git reset --hard"        -> git reset/clean
```

**Two — Jev was down and nothing said so.** 45 rows with `source: "none"` in
`gate-decisions.jsonl` over that window. Fail-open let them through, correctly.

**Three — the panel could not show it.** `toGateDecisionRecord` in
`read-measurements.mjs` did not list `'none'` among valid sources, so every
one of those rows was discarded as malformed and the board's "passed
unjudged" count could only ever render zero. **Fixed in `7be24c3`**, with a
regression test.

---

## Measured evidence (live Jev API, 2026-09-24)

### There is room for a deny threshold

Everyday work tops out at **1.56**. Catastrophic starts at **2.05**. A gap of
0.49 — wider than the 0.32 band the existing 1.78 ceiling sits in.

| catastrophic | score | everyday | score |
| --- | --- | --- | --- |
| `kubectl delete namespace production` | 2.97 | `grep -rl old src \| xargs sed -i` | 1.56 |
| `rm -rf /` | 2.81 | `docker rm my-container` | 1.11 |
| `rm -rf $HOME` | 2.49 | a `python3` heredoc that writes a file | 0.82 |
| `terraform destroy -auto-approve` | 2.31 | `rm -rf node_modules` | 0.57 |
| `TRUNCATE TABLE orders` | 2.24 | `npm install` | 0.51 |
| `DROP TABLE users` | 2.21 | `node --test` | 0.06 |
| `git push --force origin main` | 2.05 | `grep -rn TODO src` | 0 |

Proposed deny ceiling **~2.30** — conservative, not the midpoint, because the
lowest catastrophic sample is 2.05 and scores move.

### One sample is not enough inside the band

Repeat the same question and the answer is stable far from the line and noisy
near it:

```
git reset --hard        1.99 · 1.99 · 1.99     stable
grep -rn TODO src       0.00                   stable
git checkout -q main    1.41 · 1.40 · 1.49     +/- 0.09
git checkout -- <file>  1.84 · 1.84 · 1.83     asks
git restore   <file>    1.74 · 1.73 · 1.74     passes
```

The last two are **the same destructive action**, separated by four
hundredths. Inside the band, one call decides by noise.

### We discard information Jev already sends

A `ScoreAnswer` (`src/core/jev.ts:70`) carries `score`, `probabilities` and
`confidence`. The cache stores `{decision, reason, at}` — confidence is
thrown away. There is precedent for using it in this codebase:
`decisions.ts:225` gates policy coverage on `confidence`, and
`skill_decisions.ts` / `tool_decisions.ts` rank on `probabilities`.

### The other calibration channel is structurally dead

`gate-approvals.jsonl`: 61 pendings, 50 joined, **49 approved, 0 refused by a
human** (the single `rejected` row carries the test id `tu_end2end`). Under
`bypassPermissions` neither Esc nor "No" fires any event. Accumulated
per-shape scores are the only calibration signal left.

### The cache as it stands

436 entries, 427 `allow` / 9 `ask`. Keyed by command **shape**
(`commandShape` folds cwd, home, destinationId, treeRoot, repoContext), never
by text. `null` — never cached — when the command contains a substitution.
First answer wins for 30 days; no second observation, no consolidation.

---

## The design being proposed

**Ask as many times as the distance to the line deserves.**

- **Far from the line** (well below or well above): one call, cache it, done.
- **Inside the band**: first answer is used but marked *unsettled*; the next
  time that shape appears, ask again and consolidate.
- **Settled** (N observations agreeing): freeze it, longer TTL, stop asking.

Costs more calls at first, only where the answer is genuinely doubtful, and
ends up cheaper than today because a settled entry can outlive 30 days.

Store the score and the confidence per observation, not just the verdict, so
consolidation can be a confidence-weighted median rather than a vote — and so
the accumulated scores become the calibration evidence approvals cannot give.

### Open decisions (the user's, not the implementer's)

Proposed in that session, not yet confirmed:

- Observations to settle an entry: **3**.
- TTL: **90 days** settled, **7 days** unsettled-in-band. Today everything is 30.
- Store score + confidence per observation: **yes**.
- Deny ceiling: **~2.30**.

### Also in scope, independent of the cache

Extend the `resetClean` deny rule to `git checkout -- <path>`,
`git checkout .` and `git restore <path>`, **without** catching
`git checkout <branch>`, which is harmless and constant. Align the family
classifier so the panel groups them with the other destructive families.

---

## SDD state

Session preflight, collected with `AskUserQuestion` and **not to be re-asked**:

- `execution_mode: auto`
- `artifact_store: engram` (project `orca-supervisor`)
- `delivery_strategy: auto-chain`

`sdd-init` was launched for the project. `gentle-ai sdd-status` reports
`nextRecommended: sdd-new`, so the route is explore then propose. Note the
dispatcher reports `artifactStore: openspec` because an `openspec/` folder
exists in the repo; the user chose Engram, and that choice wins. If the
dispatcher refuses, report it rather than silently switching stores.

Two Engram topics hold the background:
`gate/deny-threshold-evidence` and `panels/advisor-board`.

Note on the preflight tool: the three questions must carry the exact host
markers `Gentle AI SDD preflight 1/3:` and so on, and the options must stay in
the contract's order (Interactive/Automatic, OpenSpec/Engram/Both,
Ask me/Single PR/Auto). Reordering them to put a recommendation first makes
the dispatcher reject the preflight as uncorroborated. That mistake cost a
round trip.

---

## What is already done — do not redo it

Landed on `feat/panel-interventions-and-mod-copy` (`65480ed` and earlier):

- **The skills mod copy works for the first time.** `fs.cp` is denied under
  the worker's permission sandbox, exactly as `fs.symlink` was — 0.3.1 swapped
  one forbidden API for another, so the mod had never once landed. Now a
  manual walk with `readdir`/`mkdir`/`readFile`/`writeFile`, carrying the file
  mode across with `chmod` (permitted; measured). Verified under the real
  sandbox on macOS (5/5 targets) and in a Linux container (1/1).
- `modCopyDetail` carries the real error text and `modCopyTargets` counts
  landed/failed, so `ok: true` can no longer be read as "it installed
  everywhere" when it installed nowhere.
- `source: 'none'` survives the reader's guard, with a regression test.
- `pluginVersion` on each decision record; **p95** beside the median;
  per-family `interventions`; `notRunByCommandFamily`.

637 tests passing at the branch point.

## Still open on that other branch (not this one)

The Advisor board rendering: interventions-only family table (max 15 rows plus
a "N families with no interventions" row — measured: 91 families, **61 with
zero interventions**, and sorting by total buries `terraform` at 17 asks out
of 18 while `grep` at 216/0/0 takes a row); live status without raw UUID pairs;
a status strip; a time window; and the empty-log state. Spec in
`~/Desktop/PANEL-ADVISOR.md`.

## Hard constraints to respect

- **Sandbox**: `fs.cp` and `fs.symlink` are DENIED in the plugin worker's
  sidecars. `readdir`, `mkdir`, `readFile`, `writeFile`, `chmod` are permitted.
  Wildcards on the grants change nothing. This cost two releases.
- **Paths**: `src/core/paths.ts` refuses a real config or cache directory under
  the test runner unless `ORCA_SUPERVISOR_CONFIG_DIR` / `ORCA_SUPERVISOR_CACHE_DIR`
  are set. Thirteen test files were writing to the developer's real config
  before that guard existed, and one run destroyed their policies.
- **Strict TDD is on.** Runner: `node --test --experimental-strip-types`.
  Observe a real RED before implementing; never claim one you did not see.
- **`src/core` is pure**: no I/O, no clock, no randomness. Time and randomness
  are injected.
- **No invented numbers anywhere a user can read them.** No money, ever.
- Screenshots: 1440 / 768 / 390 / 320, both themes, and read every image.
  `npm run check` renders them. Two concurrent runs delete each other's
  working directory, so never read screenshots while another run may be going.

---

## Plan review findings (2026-09-24)

A review of "The design being proposed" against the code, done while the
checkout/restore deny rule and the seed refresh landed
(odd/tasks/gate-destructive-restore-and-seed-refresh.md). These are inputs to
the cache-redesign change (SDD, next PR). Line numbers are from commit
`45bf189`.

1. **Cache migration: a reset is accepted, and it must be explicit.** The user
   accepted that the cache may be reset on this update, so no
   backward-compatible reader is needed. The reset must be deliberate: a
   versioned cache key or a schema tag on the file, read and compared on
   load. It must not be a silent drop by the entry validator. Today
   `pruneGateCache` (`src/core/gate_cache.ts:76`) drops malformed entries one
   by one, so a new entry shape would vanish entry by entry and nobody could
   tell a migration from a corrupt file.

2. **The ~2.30 deny ceiling is redundant for every catastrophic example, and
   has no verdict to land in.** Every catastrophic row in the measured table
   is already denied by a local regex before Jev is asked: `kubectl delete`
   (`rule.kubectlDelete`), `rm -rf /` and `rm -rf $HOME` (`rule.rmRf`),
   `terraform destroy` (`rule.terraformDestroy`), `DROP`/`TRUNCATE`
   (`rule.dropTable`), `git push --force` (`rule.forcePush`). The threshold
   would only ever act on commands no rule names, and the table has none of
   those. Separately, `GateVerdict` is `"allow" | "ask"`
   (`src/core/decisions.ts:341`), so a deny needs a new `deny` arm there. Every
   consumer then has to handle it: gate-bash's verdict mapping, the
   measurement/approval records, and the panel defaults publisher
   `publishGateDefaults` (`adapters/orca/main.mjs:651`), which today only
   carries `consequenceCeiling`. The literal `2.3` also exists at
   `decisions.ts:502`, where it picks the reason text
   (`reason.breaksSomethingImportant` vs `reason.needsCleanupAfter`). A deny
   ceiling and that reason split must be one named constant, not two literals
   that drift.

3. **A 90-day TTL contradicts the cache's own stated rationale.**
   `gate_cache.ts:25-39` says 30 days was chosen because what goes stale is
   what is NOT in the key: model judgment and the catalog/policy mirror at call
   time. "A quarter is too long to trust blindly against either drifting."
   Policy and catalog drift are still not in the key (and T2 of this PR just
   changed the shipped policies). A 90-day settled TTL needs either the
   policy/catalog digest folded into the key, or a written reason why that
   rationale no longer holds.

4. **Confidence is dropped four layers above the cache.** The plan stores score
   and confidence per observation, but confidence never reaches the cache
   writer. `decideAction` produces the axes. `GateActionResult.axes` carries
   only `reversible`/`external`/`consequence`/`ceiling`. `JevOutcome.axes`
   (`adapters/claude/gate-bash.ts:677-690`, `GateAxes`) carries the same.
   `appendPendingApproval` records those. The cache write
   (`gate-bash.ts:916`) stores only `{decision, reason, at}`. Carrying
   confidence means widening every one of those types, not just the cache
   entry.

5. **"Settle" is defined twice, inconsistently, and the band has no width.**
   The invariant says "a shape whose score lands near the threshold does not
   settle on one observation". The design says "Settled (N observations
   agreeing)". One is about distance to the line, the other about agreement
   count. Neither says what "near" or "inside the band" means numerically.
   The measured noise near the line is +/-0.09 (`git checkout -q main`), but
   no band width was ever chosen.

6. **Two smaller leaks.** `commandShape` returns null (never cached) on globs
   as well as substitutions (`src/core/command_shape.ts:93`: `UNKNOWABLE`
   matches `*` and `?[`). So "one call per shape" does not hold for any
   globbed command, and those will never accumulate observations.
   `pruneGateCache(raw, now = Date.now())` (`gate_cache.ts:76`) defaults the
   clock inside `src/core`, which breaks the "src/core is pure" constraint.
   The default should go, and the caller should inject `now`.

**Still open (the user's decisions, unchanged by this review):**

- Observations to settle an entry: proposed **3**. Open. Finding 5 must be
  resolved first (agreement count vs distance band).
- TTL: proposed **90 days** settled / **7 days** unsettled. Open. See finding 3.
- Store score + confidence per observation: proposed **yes**. Open. See
  finding 4 for the cost.
- Deny ceiling: proposed **~2.30**. Open. See finding 2: redundant for every
  measured catastrophic example, and it needs a `deny` verdict arm first.
