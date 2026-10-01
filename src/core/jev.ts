// Shared, generic Jev (TypeSafe) HTTP client for the plugin.
//
// This module is the single place that knows how to talk to
// `POST https://api.typesafe.ai/v1/systemone`: it builds nothing
// domain-specific (no destination lists, no command patterns -- that lives
// in decisions.ts, which builds Question sets and interprets Answer sets).
// It only knows the wire shape, validates it with hand-written guards, and
// enforces the two operational rules measured against the live API:
//
//   - a `noul` question's `criteria` MUST be an object (a plain string
//     returns HTTP 422 -- "model_attributes_type ... Input should be a
//     valid dictionary or object").
//   - a `score` answer's `legend` comes back as an OBJECT keyed by level
//     index (e.g. {"0": "...", "1": "..."}), never as a single string.
//
// The API key is always a parameter. This module never reads
// process.env, never reads a file, and never logs the key or includes it
// in a thrown error -- callers resolve the key with secrets.ts and hand it
// in explicitly.

import { isNumber, isRecord, isString, isStringRecord } from "../guards.ts";

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  // Must be an object of named sub-criteria, never a bare string -- see
  // the module comment above. Optional only in the sense that a caller
  // could theoretically omit it, but doing so is not recommended: every
  // noul question in this project ships with explicit criteria.
  criteria?: Record<string, string>;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** The most options Jev accepts in one choice question; more is a 400 ("Too many choices"), measured live on 2026-09-28. */
export const MAX_JEV_CHOICES = 255;

export interface JevRequest {
  state: JsonValue;
  model: "jev-latest";
  questions: Record<string, Question>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * 0.6.22 T1 (JEVADV-97): the top probability minus the runner-up, how far
 * ahead Jev's first option is. Undefined, never 0 or NaN, when the map has
 * fewer than two entries or any value is not a finite number.
 */
export function answerMargin(probabilities: unknown): number | undefined {
  if (!isRecord(probabilities)) return undefined;
  const values = Object.values(probabilities);
  if (values.length < 2 || !values.every(isNumber)) return undefined;
  const [top, runnerUp] = [...values].sort((a, b) => b - a);
  return top === undefined || runnerUp === undefined ? undefined : top - runnerUp;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  // Keyed by each level's zero-based index, as a string ("0", "1", ...) --
  // measured live against the real API, never a single descriptive string.
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: JevUsage;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
  if (!isRecord(value) || value.type !== "choice") return false;
  return isString(value.choice) && isRecord(value.probabilities) && isNumber(value.confidence);
}

function isScoreAnswer(value: unknown): value is ScoreAnswer {
  if (!isRecord(value) || value.type !== "score") return false;
  return isNumber(value.score) && isStringRecord(value.legend) && isRecord(value.probabilities) && isNumber(value.confidence);
}

function isNoulAnswer(value: unknown): value is NoulAnswer {
  if (!isRecord(value) || value.type !== "noul") return false;
  return isNumber(value.noul);
}

function isAnswer(value: unknown): value is Answer {
  return isChoiceAnswer(value) || isScoreAnswer(value) || isNoulAnswer(value);
}

function isJevUsage(value: unknown): value is JevUsage {
  return isRecord(value) && isNumber(value.input_tokens) && isNumber(value.output_tokens);
}

function isJevResponse(value: unknown): value is JevResponse {
  if (!isRecord(value)) return false;
  if (!isString(value.model)) return false;
  if (!isRecord(value.answers)) return false;
  for (const answer of Object.values(value.answers)) {
    if (!isAnswer(answer)) return false;
  }
  return isJevUsage(value.usage);
}

/** Reads a `choice` answer by id, or null if absent/malformed -- never throws. */
export function getChoiceAnswer(answers: Record<string, Answer>, id: string): ChoiceAnswer | null {
  const answer = answers[id];
  return answer !== undefined && answer.type === "choice" ? answer : null;
}

/** Reads a `score` answer by id, or null if absent/malformed -- never throws. */
export function getScoreAnswer(answers: Record<string, Answer>, id: string): ScoreAnswer | null {
  const answer = answers[id];
  return answer !== undefined && answer.type === "score" ? answer : null;
}

/** Reads a `noul` answer by id, or null if absent/malformed -- never throws. */
export function getNoulAnswer(answers: Record<string, Answer>, id: string): NoulAnswer | null {
  const answer = answers[id];
  return answer !== undefined && answer.type === "noul" ? answer : null;
}

// ---------------------------------------------------------------------------
// Injectable transport
// ---------------------------------------------------------------------------
//
// This module is shared, unmodified, by three kinds of callers: the CLI
// tools and adapters/claude/gate-bash.ts (a real Node process, with a
// global `fetch` and real timers), and adapters/claude/mod-skills (a
// Claude Code function-hooks module). That third environment is not Node
// and not a browser: per Anthropic's mod type declarations
// (mods/types/claude-code.d.ts), a hooks module's globals are "these and
// no others (no DOM, no Node)" and it "neither has timers" -- there is no
// `fetch` (the host's network is reached only through `$.http.fetch`) and
// no `setTimeout`/`clearTimeout` (a hooks module waits on `$.clock`
// instead). Naming either identifier directly in this file would fail to
// type-check the moment the mod's own tsconfig (typed only against that
// declaration file) pulls this module in through its import graph -- and
// would throw at runtime in that environment regardless of typing.
//
// So neither is ever named directly here. Both are optional dependencies
// of `callJev`, each defaulting to the global reached through a narrow,
// explicit cast on `globalThis` -- present and real under Node (every
// existing caller keeps working with zero changes), simply absent under
// the mod, whose adapter supplies its own (`$.http.fetch` wrapped to this
// shape, and `$.clock.sleep` for the wait).

/** The minimal request shape `callJev` sends; satisfied by the global `fetch`. */
export interface JevFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** The minimal response shape `callJev` reads; satisfied by the global `fetch`'s `Response`. */
export interface JevFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  /** Present on the global `fetch`'s `Response`; a transport without it simply never offers a `Retry-After`. */
  readonly headers?: { get(name: string): string | null };
}

export type JevFetch = (url: string, init: JevFetchInit) => Promise<JevFetchResponse>;

/**
 * Resolves after `ms` milliseconds; satisfied by `$.clock.sleep` or a
 * `setTimeout` wrapper. `signal`, when given and honoured, ends the wait
 * early and releases the timer (0.6.13 T5: the default one does, so the
 * gate hook's process is free to exit once its verdict is written).
 */
export type JevSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The global `fetch`, narrowly cast -- never named directly (see above). Null where there is none. */
function defaultFetch(): JevFetch | null {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as JevFetch) : null;
}

/**
 * The global timer, narrowly cast -- never named directly (see above). Null
 * where there is none. An aborted `signal` clears the timer and resolves at
 * once (JEVADV-68: the losing budget timer kept the gate process alive for
 * the rest of the budget, a median 1.4 s after the verdict was written).
 */
export function defaultSleep(): JevSleep | null {
  const candidate = (globalThis as { setTimeout?: unknown }).setTimeout;
  if (typeof candidate !== "function") return null;
  const schedule = candidate as (fn: () => void, ms: number) => unknown;
  const clearCandidate = (globalThis as { clearTimeout?: unknown }).clearTimeout;
  const clear = typeof clearCandidate === "function" ? (clearCandidate as (handle: unknown) => void) : null;
  return (ms: number, signal?: AbortSignal) =>
    new Promise((resolvePromise) => {
      const handle = schedule(() => resolvePromise(), ms);
      signal?.addEventListener(
        "abort",
        () => {
          clear?.(handle);
          resolvePromise();
        },
        { once: true },
      );
    });
}

// ---------------------------------------------------------------------------
// Network call
// ---------------------------------------------------------------------------

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RETRYABLE_STATUS = new Set([429, 529]);
const MAX_RETRIES = 1;
const DEFAULT_BUDGET_MS = 4_000;
/**
 * A transient failure (5xx, network) earns its one retry only when a whole
 * call still fits in what is left of the budget after the wait. Measured over
 * 17,687 real gate calls, Jev answered in a median of 395 ms, p99 1,137 ms and
 * at most 1,809 ms; 1,500 ms covers the p99 with margin, so a retry that
 * starts is one that can finish. Below it the call fails open at once.
 */
const MIN_RETRY_WINDOW_MS = 1_500;
/** The wait before a transient retry when Jev gave no `Retry-After`. */
const TRANSIENT_BACKOFF_MS = 250;

/** A `Retry-After` header as milliseconds: whole seconds or an HTTP date. Null when absent or unreadable. */
function retryAfterMs(value: string | null | undefined, now: number): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Why a Jev call failed (JEVADV-96). Every failure `callJev` throws carries
 * one, so the gate's measurement rows can say why a command went unjudged.
 *   timeout  -- the latency budget ran out.
 *   network  -- the request never got an answer (connection refused, reset, DNS).
 *   http4xx  -- Jev refused the request (400-499 except 429); `status` says which.
 *   http5xx  -- Jev failed on its side (500-599 except 529).
 *   overload -- 429 or 529: Jev asked callers to slow down.
 *   malformed -- a 200 whose body is not the expected answer.
 */
export type JevFailure =
  | { readonly kind: "timeout" }
  | { readonly kind: "network" }
  | { readonly kind: "http4xx"; readonly status: number }
  | { readonly kind: "http5xx"; readonly status: number }
  | { readonly kind: "overload"; readonly status: number }
  | { readonly kind: "malformed" };

export type JevFailureClass = JevFailure["kind"];

function failureFromStatus(status: number | null): JevFailure {
  if (status === null) return { kind: "network" };
  if (RETRYABLE_STATUS.has(status)) return { kind: "overload", status };
  return status >= 500 ? { kind: "http5xx", status } : { kind: "http4xx", status };
}

export class JevTimeoutError extends Error {
  readonly failure: JevFailure = { kind: "timeout" };
  constructor(budgetMs: number) {
    super(`Jev didn't respond within the ${budgetMs}ms budget`);
    this.name = "JevTimeoutError";
  }
}

export class JevRequestError extends Error {
  readonly status: number | null;
  readonly failure: JevFailure;
  /** `malformed` marks a 200 whose body is not a Jev answer; otherwise the class follows from `status` (null: the request never got an answer). */
  constructor(message: string, status: number | null, malformed = false) {
    super(message);
    this.name = "JevRequestError";
    this.status = status;
    this.failure = malformed ? { kind: "malformed" } : failureFromStatus(status);
  }
}

/** The class of a failure thrown by `callJev`, or null for any other error. */
export function jevFailureOf(error: unknown): JevFailure | null {
  return error instanceof JevTimeoutError || error instanceof JevRequestError ? error.failure : null;
}

export interface CallJevOptions {
  /** Hard latency budget in milliseconds; enforced via AbortController. */
  budgetMs?: number;
  /**
   * Stands in for the global `fetch`. Every existing caller omits this and
   * gets the real global; a caller whose environment has none (the mod)
   * must supply one -- typically `$.http.fetch` adapted to `JevFetch`.
   */
  fetchImpl?: JevFetch;
  /**
   * Stands in for the global timers, used both for the retry backoff and
   * to schedule the budget's abort. Every existing caller omits this and
   * gets a real `setTimeout`; a caller whose environment has none (the
   * mod) must supply one -- typically `$.clock.sleep`.
   */
  sleepImpl?: JevSleep;
  /** Stands in for `Date.now`, which times how much of the budget is left before a transient retry. */
  nowImpl?: () => number;
}

/**
 * Sends one Jev request and returns the validated, typed response.
 *
 * - `apiKey` is always supplied by the caller; this function never reads
 *   the environment or the filesystem, and never logs the key or includes
 *   it in a thrown error.
 * - Retries at most once per call, whatever the cause. A 429 (rate limited)
 *   or 529 (overloaded) is retried after a 500ms backoff. A 5xx or a network
 *   failure is retried after its `Retry-After` (else 250ms), only when what
 *   is left of the budget still fits a whole call (MIN_RETRY_WINDOW_MS); the
 *   retry is given only that remainder. Any other failure throws at once.
 * - Every thrown failure carries its class (`jevFailureOf`).
 * - Enforces a hard latency budget (default 4000ms): an AbortController is
 *   always created and its `signal` always sent, so a `fetchImpl` that
 *   honours it (the global `fetch`) cancels the underlying request; the
 *   budget itself is timed with the injected/default `sleepImpl` racing
 *   the request, so the promise settles on time even against a transport
 *   that cannot be cancelled (`$.http.fetch` takes no signal). Exceeding
 *   it throws JevTimeoutError so callers can fail open instead of hanging.
 * - Throws JevRequestError immediately, with no network call, when no
 *   `fetchImpl` or `sleepImpl` is available (neither injected nor a global
 *   to fall back on) -- this is the mod's fail-open path when its adapter
 *   is misconfigured, never a hang.
 */
export async function callJev(apiKey: string, state: JsonValue, questions: Record<string, Question>, options: CallJevOptions = {}): Promise<JevResponse> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const doFetch = options.fetchImpl ?? defaultFetch();
  const doSleep = options.sleepImpl ?? defaultSleep();
  if (!doFetch) throw new JevRequestError("callJev: no fetch implementation available (neither injected nor global)", null);
  if (!doSleep) throw new JevRequestError("callJev: no timers available (neither injected nor global)", null);

  const request: JevRequest = { state, model: "jev-latest", questions };

  const now = options.nowImpl ?? Date.now;
  const startedAt = now();
  let retriesUsed = 0;
  let attemptBudgetMs = budgetMs;
  for (;;) {
    const controller = new AbortController();
    let timedOut = false;
    // The loser of the race is never awaited again, but `Promise.race`
    // attaches a handler to every promise it is given up front, so this
    // one's eventual settlement (after the fetch already won) never
    // surfaces as an unhandled rejection. 0.6.13 T5: once the race is
    // settled the budget's sleep is aborted, so its timer is released and a
    // short-lived caller (the gate hook) exits right after its verdict; a
    // sleep that ignores the signal just runs out as before.
    const budgetSettled = new AbortController();
    const thisBudgetMs = attemptBudgetMs;
    const budget = doSleep(thisBudgetMs, budgetSettled.signal).then((): Promise<never> => {
      if (budgetSettled.signal.aborted) return new Promise<never>(() => undefined);
      timedOut = true;
      controller.abort();
      throw new JevTimeoutError(thisBudgetMs);
    });

    let response: JevFetchResponse | null = null;
    let networkError: JevRequestError | null = null;
    try {
      response = await Promise.race([
        doFetch(JEV_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        }),
        budget,
      ]);
    } catch (error) {
      if (timedOut || error instanceof JevTimeoutError) throw new JevTimeoutError(thisBudgetMs);
      if (error instanceof Error && error.name === "AbortError") throw new JevTimeoutError(thisBudgetMs);
      networkError = new JevRequestError(`Couldn't reach Jev: ${error instanceof Error ? error.message : String(error)}`, null);
    } finally {
      budgetSettled.abort();
    }

    let failure: JevRequestError;
    let waitMs: number;
    let transient: boolean;
    if (response === null) {
      failure = networkError ?? new JevRequestError("Jev: unknown failure", null);
      transient = true;
      waitMs = TRANSIENT_BACKOFF_MS;
    } else if (response.ok) {
      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new JevRequestError("Jev responded 200 but the body isn't valid JSON", response.status, true);
      }
      if (!isJevResponse(parsed)) {
        throw new JevRequestError("Jev responded 200 but the body doesn't have the expected shape {model, answers, usage}", response.status, true);
      }
      return parsed;
    } else {
      const bodyText = await response.text().catch(() => "");
      failure = new JevRequestError(`Jev responded ${response.status}: ${bodyText || `HTTP ${response.status}`}`, response.status);
      transient = failure.failure.kind === "http5xx";
      waitMs = transient ? (retryAfterMs(response.headers?.get("retry-after"), now()) ?? TRANSIENT_BACKOFF_MS) : 500;
    }

    if (retriesUsed >= MAX_RETRIES) throw failure;
    if (transient) {
      // The retry must be able to finish: what is left once the wait is over has to fit a whole call.
      const remainingMs = budgetMs - (now() - startedAt) - waitMs;
      if (remainingMs < MIN_RETRY_WINDOW_MS) throw failure;
      attemptBudgetMs = remainingMs;
    } else if (failure.failure.kind === "overload") {
      attemptBudgetMs = budgetMs;
    } else {
      throw failure;
    }
    retriesUsed += 1;
    await doSleep(waitMs);
  }
}
