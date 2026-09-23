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

export interface JevRequest {
  state: JsonValue;
  model: "jev-latest";
  questions: Record<string, Question>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

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
}

export type JevFetch = (url: string, init: JevFetchInit) => Promise<JevFetchResponse>;

/** Resolves after `ms` milliseconds; satisfied by `$.clock.sleep` or a `setTimeout` wrapper. */
export type JevSleep = (ms: number) => Promise<void>;

/** The global `fetch`, narrowly cast -- never named directly (see above). Null where there is none. */
function defaultFetch(): JevFetch | null {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as JevFetch) : null;
}

/** The global timer, narrowly cast -- never named directly (see above). Null where there is none. */
function defaultSleep(): JevSleep | null {
  const candidate = (globalThis as { setTimeout?: unknown }).setTimeout;
  if (typeof candidate !== "function") return null;
  const schedule = candidate as (fn: () => void, ms: number) => unknown;
  return (ms: number) => new Promise((resolvePromise) => void schedule(() => resolvePromise(), ms));
}

// ---------------------------------------------------------------------------
// Network call
// ---------------------------------------------------------------------------

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RETRYABLE_STATUS = new Set([429, 529]);
const MAX_RETRIES = 1;
const DEFAULT_BUDGET_MS = 4_000;

export class JevTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`Jev no respondió dentro del presupuesto de ${budgetMs}ms`);
    this.name = "JevTimeoutError";
  }
}

export class JevRequestError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "JevRequestError";
    this.status = status;
  }
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
}

/**
 * Sends one Jev request and returns the validated, typed response.
 *
 * - `apiKey` is always supplied by the caller; this function never reads
 *   the environment or the filesystem, and never logs the key or includes
 *   it in a thrown error.
 * - Retries exactly once, with a 500ms/1000ms backoff, and only when the
 *   response status is 429 (rate limited) or 529 (overloaded). Any other
 *   non-ok status throws immediately.
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
  if (!doFetch) throw new JevRequestError("callJev: no hay una implementación de fetch disponible (ni inyectada ni global)", null);
  if (!doSleep) throw new JevRequestError("callJev: no hay temporizadores disponibles (ni inyectados ni globales)", null);

  const request: JevRequest = { state, model: "jev-latest", questions };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    // The loser of the race is never awaited again, but `Promise.race`
    // attaches a handler to every promise it is given up front, so this
    // one's eventual settlement (after the fetch already won) never
    // surfaces as an unhandled rejection.
    const budget = doSleep(budgetMs).then((): never => {
      timedOut = true;
      controller.abort();
      throw new JevTimeoutError(budgetMs);
    });

    let response: JevFetchResponse;
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
      if (timedOut || error instanceof JevTimeoutError) throw new JevTimeoutError(budgetMs);
      if (error instanceof Error && error.name === "AbortError") throw new JevTimeoutError(budgetMs);
      throw new JevRequestError(`No se pudo contactar a Jev: ${error instanceof Error ? error.message : String(error)}`, null);
    }

    if (response.ok) {
      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new JevRequestError("Jev respondió 200 pero el cuerpo no es JSON válido", response.status);
      }
      if (!isJevResponse(parsed)) {
        throw new JevRequestError("Jev respondió 200 pero el cuerpo no tiene la forma esperada {model, answers, usage}", response.status);
      }
      return parsed;
    }

    const bodyText = await response.text().catch(() => "");
    lastError = new JevRequestError(`Jev respondió ${response.status}: ${bodyText || `HTTP ${response.status}`}`, response.status);

    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_RETRIES) {
      throw lastError;
    }
    await doSleep(500 * 2 ** attempt);
  }

  throw lastError ?? new JevRequestError("Jev: fallo desconocido tras reintentos", null);
}
