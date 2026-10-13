# Router cache TTL without `classic.Stop`, and Jev 402 (0.8.3)

## Objective

The model router knows whether the prompt cache is warm or cold on every account, including Team and Enterprise organizations, on macOS and Linux; when it cannot know, its row says why. Applied upgrades log what their rewrite cost. A Jev key without credit is reported as such, not as "unreachable".

## Evidence (2026-10-13)

- Router rows today on the owner's Mac: `cacheWarm` null in 72 of 100 stage rows. All 72 are on the two Koombea (Team) accounts (`home` and a second one); the Max account never gives null. A teammate on Koombea sees null in all 29 rows across 14 sessions (Orca, terminal, cmux, SDK).
- Claude Code 2.1.296 seats the built-in `cc-plugin-sec-default@builtin` outermost "for Team and Enterprise organizations"; its description: it "keeps the organization's classic hooks, prompt content, settings and tool policy out of reach of the plugins a person installs". `ttlMs` is only ever written by `readCacheTtl`, called only from `on('classic.Stop')`, so on those accounts it stays null and `cacheWarmth` returns null for good.
- Reproduced: an interactive Haiku session on `home` gave null on turn 2 after a Stop; the same on the Max account (with home's extra Stop hook added via `--settings`) gave true. `readCacheTail` on the null sessions' real tails returns `ttlMs` 1h, so the parser is fine.
- Applied switches without `switchCost` are all `upgrade`, `floor-restore` or `effort-raise`: they skip break-even by design (quality first) and log no cost. Every applied downgrade carried a `switchCost`.
- The partner's Fedora box (0.8.2): 6,754 gate rows `none / allow / unreachable` with `failureClass: http4xx, failureStatus: 402` since 2026-10-06T16:34Z; router all `jev-failed`. `curl` and Node reach `api.typesafe.ai` (405/403 without a key); the key file is well formed. The TypeSafe account behind the key returns 402 Payment Required.

## Scope

- R5: read the TTL (and the last main request) from the transcript tail inside the router's own path (`turn.step` / `routeStage`), not only at `classic.Stop`. The transcript path is built from the config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`), `projectSlug` of where the session started, and the session id; when that file does not exist, it is looked up by session id under `<config>/projects/*/`. Read only while the clock is unknown (once per session in practice). The `classic.Stop` path stays for accounts that get it. macOS and Linux.
- R6: when `cacheWarm` is null the router row carries `cacheUnknown`: `no-ttl`, `no-last-request` or `tail-failed`.
- R7: an applied `upgrade`, `floor-restore` or `effort-raise` logs the rewrite cost it paid (`switchCost`, 0 when the cache is known cold). Behaviour unchanged: upgrades never wait for a cold cache (quality first).
- G8: a Jev answer of HTTP 402 is its own failure: gate row `stopReason` stays countable but the notice says the key has no credit, and the router/steward rows say `jev-payment` instead of `jev-failed`.

Out of scope: deferring upgrades to a cold cache; Windows (`tail` is not there; unchanged).

## Checklist

- [x] R5 TTL from the router's own path
  - RED: `src/core/cache_warmth.test.ts` failed to load (the new `transcriptPathOf`, `transcriptFindArgv`, `foundTranscriptPath`, `cacheClockUnknown`, `mergeCacheTail` did not exist); `hooks.test.ts` "R5: with classic.Stop never fired, …" and "R5: … found by session id" failed with stage rows `cacheWarm` `[null, null]`.
  - GREEN: cache_warmth.test.ts 16/16; hooks.test.ts R2+R5 9/9 (stage rows `[true, false]` from the session's own transcript, `[true, true]` through `find` with `~/.claude`; a find that cannot start leaves `[null, null]` and the same reasons); hooks.test.ts 238/238.
- [x] R6 `cacheUnknown` reason on the row
  - RED: cache_warmth.test.ts failed to load (no `cacheUnknownOf`); model_router_decide.test.ts "R6: a row whose cache is unknown says why; …" failed (tsc: `cacheUnknown` not in `RouterDecisionRecordInput`); hooks.test.ts "R5: a transcript that cannot be read …" (`cacheUnknown` `[undefined, undefined]`) and "R6: a transcript with no cache write says no-ttl; …" failed.
  - GREEN: cache_warmth + model_router_decide + hooks: 317/317; typecheck clean.
- [x] R7 cost of applied upgrades logged
  - RED: model_router_stage.test.ts failed to load (no `qualitySwitchCost`); model_router_decide.test.ts "R7: a row given a quality switch's cost logs it as switchCost …" failed (tsc: `switchCost` not in `RouterDecisionRecordInput`); hooks.test.ts "R7: an applied upgrade logs the rewrite it paid, …" failed (`switchCost null`).
  - GREEN: model_router_stage + model_router_decide + model_router_summary + hooks: 386/386. "R7: the decision itself is the same warm, cold or unknown: upgrades never wait" proves upgrade, floor-restore and effort-raise decisions are deep-equal across `cacheWarm` true/false/absent; the record differs from before only in `switchCost` (80k on Opus 5.5: $0.64; 0 when known cold; null without context or prices). Not covered: the engine-started turn's `floor-restore` (`routeEngineTurn`), whose row never weighed the cache.
- [x] G8 402 named as "no credit"
  - Gate: a 402 still passes (fail-open) and still writes `none / allow / unreachable` (counted as a failed call by `gateJevCalls`), with `failureClass: http4xx, failureStatus: 402` as the distinct detail it already carried; only the notice changes, to `jevNoCredit` (es/en) through `unreachableNoticeKey`. No new stopReason, so `isGateStopReason` and its readers are unchanged.
  - Router/steward/subagent: `isJevPaymentFailure(jevFailureOf(error))` turns a `jev-failed` decision into `jev-payment` (start, stage, subagent and matched teammate rows; steward rows) via `withJevPayment` / `withStewardPayment`; nothing else is decided differently. `subagentWhy` reads it as `no-jev`, `routerJevCalls` as a failed call, and a teammate with it is not `teammate-routed`. Not changed: verify-done (`jev-failed`), the `agent-model.ts` classic hook, and the router reasons have no on-screen text.
  - RED: jev_call.test.ts and gate_unreachable_notice.test.ts failed to load (no `isJevPaymentFailure`, `unreachableNoticeKey`); i18n_catalogs "G8: the no-credit gate notice …" failed (no `jevNoCredit`); hooks.test.ts "G8: a Jev answer of 402 (no credit) names the router rows jev-payment, …" (`[start, jev-failed], [stage, jev-failed]`) and "G8: a subagent judged into a 402 …" (`jev-failed`); steward.test.ts "G8: a Jev answer of 402 is logged jev-payment, …" (`jev-failed`); subagent_status and module_cost reader assertions for `jev-payment` failed.
  - GREEN: those seven files 358/358; typecheck clean.
- [x] Release 0.8.3 (docs, version, QA)
- [ ] Live: a Team-account session gives `cacheWarm` true/false (PASS, qa-0.8.3 #10); the partner's Linux shows the 402 notice text (read-only check, waits for his update)

## Acceptance

- On a session whose classic events never arrive, the second turn's stage row has `cacheWarm` true or false.
- A null `cacheWarm` row always has `cacheUnknown`.
- Applied upgrades have `switchCost`.
- A 402 from Jev never prints "unreachable".
- `npm run typecheck`, `npm test`, `npm run test:panels` green.

## Checks

Strict TDD per task: RED observed, then GREEN. One Conventional Commit per task on `fix/router-cache-ttl`.
