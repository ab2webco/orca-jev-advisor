# Gate model spend: measure, then cut what the gate spends on Jev and Clef

## Objective

Spend fewer Clef neurons and fewer Jev calls per day on the Bash gate, with no loss of safety. Replaying real commands must change no verdict in a way that lets a deny, an ask or an advice through as an allow. Release 0.13.8.

## Data

All the data is real. Nothing is mocked. The harness and outputs are in this session's scratchpad (`spend/`).

- **Gate logs.** `~/.cache/orca-supervisor/gate-decisions-*.jsonl` and `clef-neurons-*.jsonl`, 2026-10-17 to 10-19.
- **Commands.** 9,250 unique Bash commands (text plus cwd) taken from the transcripts for 10-17 to 10-19. Each was run through the real hook (`adapters/claude/gate-bash.ts`) with `fetch` intercepted, so nothing left the machine, and the exact state and questions the gate built were captured.
  - 3,987 reached a model.
  - 3,607 were tier 1a.
  - 1,636 had a cwd that no longer exists.
  - 20 were stopped by a local rule.
- **Transcripts as a stand-in for the log.** For 10-18, transcript counts per family match the log's model rows: sed 112 vs 110, cat 89 vs 94, grep 80 vs 81, ls 50 vs 50, echo 37 vs 38.
- **Live sample.** 60 recent commands that carry policies: 25 from risky buckets and 35 others. Each was asked to Clef (`clef-omni`) and to Jev with the full question set, and again without the permits questions (`coverage`, `same_kind`). Every answer was then replayed through the real hook to read the verdict. That run cost 3,131 Clef neurons, which were appended to the 10-19 neuron ledger so the gate's 9,000 stop counts them.
- **Real stops.** Gate stops and advices since 10-17, joined back to their command text: 33 by `toolUseId` from `gate-approvals.jsonl`, and 337 by time and family from the decision rows.

## Before (2026-10-18, a full day)

| | |
|---|---|
| Gate decisions | 3,196 |
| Decisions that called a model | 2,725 (excluding advice-retry and authorized) |
| Clef calls | 328, then the 9,000 stop at 13:10Z |
| Clef neurons | 9,020, 27.5 a call (293 `clef-omni`, 35 `clef-flash`) |
| `clef-omni` alone | 30.5 neurons a call (2,239 input tokens, live sample) |
| Answered by Jev after the budget ran out (`escalation: budget`) | 1,917 |
| Clef-decided share on 0.13.6 | 54 Clef / 91 policy (10-18); 68 Clef / 59 policy (10-19 so far) |
| Live sample | 11 of 60 Clef-decided; 46 of 60 escalated `policy` |

## Measurement

### (a) Which policy questions trip the 0.2 floor, and whether Jev agrees

In the live sample, 46 of 60 Clef answers tripped the floor. These were the trips; one answer can count under more than one:

| Trip | Count |
|---|---|
| `violation`, `never_write_to_main` at ≥ 0.2 | 45 |
| `violation`, choice `never_write_to_main` | 44 |
| `needs_person`, `others_pr` | 2 |
| `violation`, `large_pr` | 1 |

On those 46 commands, Jev's verdict matched Clef's on **17**. Clef's own verdict would have been a `never_write_to_main` deny on 29 commands that Jev allowed or advised. Examples: `gh pr view`, `gh release list`, `orca orchestration send`, `orca plane issue`, `"$ORCA_GAME_CLI" game launch`, `python3 -I -c` reading a JSON file. Clef reads `never_write_to_main` badly, so the floor is what keeps those denies out. Lowering the floor, or skipping Jev when Clef says `none`, is not safe.

`never_write_to_main` is asked on 1,983 of the 3,987 model calls. 1,726 of them come from the orca-oss main checkout, where the game lead runs `orca`, `"$ORCA_GAME_CLI"`, `gh` and `python3`.

### (b) Why read-only families still reach a model

The reason was classified per segment that is not tier 1a, over the 3,987 model calls:

| Family | Calls | Why |
|---|---|---|
| cat | 259 | Mostly `cat > file <<EOF` heredocs that write a file, and `cat x \| python3 -c` |
| sed | 192 | 49 `sed -i` (writes). 35 `sed -n N,Mp $VAR/file` (a `$` operand, refused on purpose since 0.13.5). The rest are compounds with `git grep`, `node` or `npx` |
| grep | 150 | 23 substitutions. 24 a `<` or `>` inside quotes (`grep "call<"`) that tier 1a reads as a redirect. Others are compounds with `npx`, `node` or `python3`, or a real redirect to a file |
| ls | 59 | Compounds with `python3`, `node`, `pgrep` or `lsof` |
| echo, printf | 69 | Real writes (`>> file`), `$ORCA_GAME_CLI`, `orca` |

Most of these commands really write, or run an interpreter. Tier 1a is right to send them on. The forms that are provably read-only and still missed, counted over the 3,987:

| Form | Calls |
|---|---|
| A `<`/`>` inside quotes | 42 |
| Read-only git subcommands (`git grep`, `ls-files`, `rev-list`, `merge-base`, `for-each-ref`, ...) | 71 |
| `pgrep`, `ps`, `lsof` | 29 |
| Together | **143 (3.6%)** |

Read-only `orca` subcommands add 28 (`orca orchestration check` acknowledges messages, so it is not read-only). Shell loop keywords add 31.

### (c) Neurons per Clef call: fixed prompt vs policy text

Measured on the 3,987 captured requests and the live sample:

| Part of the request | Share of characters | Tokens | Neurons |
|---|---|---|---|
| Fixed: state (command, context) plus risk questions | 23% | ~510 | ~7 |
| Policy questions | 77% | ~1,730 | ~23.6 |
| …of which permits (`coverage` + `same_kind`) | 27% | 558, measured | 7.6 |
| …of which `violation` | 30% | | |
| …of which `needs_person` | 21% | | |
| **Whole request (`clef-omni`)** | | 2,239 | 30.5 |

The permits questions never change a verdict. In `decideGateAction`, a permits match (`act`) falls through to the risk stage. `gatePolicyHit` reads only `violation` and `needs_person`. Nothing else reads `coverage` or `same_kind`; the gate is the only caller of `buildPolicyQuestions`.

### Cuts considered

| Cut | Measured saving | Safety |
|---|---|---|
| **C1. Stop asking the permits questions** | −25% Clef neurons a call (30.5 → 22.9), so ~393 Clef calls a day instead of ~295 on `clef-omni`. −21% Jev input tokens a call (2,084 → 1,638) | Provable. Deterministic replay of 260 recorded answer sets (37 deny, 49 advise) through the real hook with `coverage`/`same_kind` removed: 0 changes |
| **C2. Tier 1a for the provably read-only forms above** | 143 of 3,987 model calls (3.6%), so ~98 fewer model calls a day | Each form reads only. Checked against every real stop and advice |
| Branch reach for `orca`/`gh`/git reads | `never_write_to_main` dropped on 210 of 1,983 (10.6%); 7 of 46 sampled trips vanish. That is ~20 Jev calls a day, and only in Clef's hours | Safe on the 11 real `never_write_to_main` denies, but a smaller saving than C2 |
| Skip Jev when Clef says `none` | — | Unsafe: Clef is wrong on 29 of 46 trips |

C1 and C2 ship. C1 does not raise the Clef-decided share: with and without the permits questions, 46 of 60 escalated as `policy`. It makes each call cheaper, so Clef answers about 100 more calls a day before the stop.

**Model shift (C1).** Without the permits questions, Clef's own `violation` answers move: 27 of 60 Clef verdicts changed, mostly `never_write_to_main` deny → allow. Jev's answers do not move: 1 of 60 changed, an advise → allow on `orca orchestration check --ack ...; orca orchestration send`. Asked four more times each way, Jev's consequence on that command was 1.61–1.72 with the permits questions and 1.66–1.74 without, both straddling the orca-oss line of 1.66. That one change is Jev's noise at the line, not an effect of the cut. The cascade's routing (which provider answers) was the same on 58 of 60. One command moved from `doubt` (Jev) to Clef, with the same verdict. On the other, the lean Clef call was not made because the neuron cap was reached.

## Scope

- **C1.** The gate stops sending the permits policies to Jev and Clef: `coverage`, `same_kind`, and the permits rule text. The gate builds its questions and reads its answers through `gateJudgedPolicies`, which keeps only `prohibits` and `requires_human`. The `coverage` branch of `interpretDestinationPolicy` stays: `advisor.decide` (`adapters/orca/main.mjs`) still asks it, and there a permits match does decide. Permits policies stay in the panel and the policies file. They also stay in `commandScopedPolicies`, so the cache key and the local-allow shortcut behave exactly as before.
- **C2.** Tier 1a (`isSafeSegment`) changes in three ways:
  - A `<` or `>` inside single or double quotes is not a redirection. A segment with `$'...'` or an unclosed quote keeps the old character test.
  - `git grep` (without `-O`/`--open-files-in-pager`), `ls-files`, `rev-list`, `merge-base`, `for-each-ref`, `ls-tree` and `describe` are safe.
  - `pgrep`, `ps` and `lsof` are safe.
- **Hole closed in C2.** `--output` (in any GNU prefix spelling) is refused on every safe git subcommand: `git diff --output=f` writes `f` and was tier 1a before.
- **Out of scope.**
  - `src/core/gate_advice_text.ts` (0.13.7).
  - The floor, the doubt band, `branch_reach.ts`.

## Checklist

- [x] T1 C1: the gate asks no permits question.
  - RED: `gate-providers.test.mjs` "a permits policy is not asked", in Jev and Both modes. The request carried `coverage` and `same_kind`. `decisions.test.ts` `gateJudgedPolicies` failed on the missing export.
  - GREEN: both tests pass. A violation answer keyed `policy_1` still resolves to the real prohibition behind a permits policy listed first. `decisions.test.ts`, `gate-bash.test.mjs` and `provider_cascade.test.ts`: 494 of 494 pass.
- [ ] T2 C2: tier 1a takes the quoted `<`/`>`, the read-only git subcommands and `pgrep`/`ps`/`lsof`, and refuses git `--output`. RED tests for each form, and for the forms that must stay out (`$'…'`, an unclosed quote, `git grep -O`, `git diff --output=x`, `git log --out=x`).
- [ ] T3 Replay: every captured command through the new hook vs the old. Zero commands whose real or replayed verdict was deny, ask or advise become allow or tier 1a. Model calls before vs after.
- [ ] T4 Release 0.13.8: CHANGELOG, version bump, `npm run typecheck`, `npm test`, PR to main (no merge, tag or release).

## Acceptance

- The replay of real commands changes 0 verdicts from deny, ask or advise to allow.
- Requests to Jev and Clef carry no permits question.
- `npm run typecheck` and `npm test` are green.
