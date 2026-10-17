// Multi-provider decisions (odd/tasks/multi-provider.md, P4): which provider
// answers one decision.
//
//   jev  -- Jev only, exactly as before this file existed (the default).
//   clef -- Clef only. Jev is never asked; a failure or a spent day is a
//           failure, which the caller handles as it handles a failed Jev call.
//   both -- Clef first, spending the free daily allowance. Jev answers when
//           Clef is in doubt (a predicate each caller supplies), fails, is
//           rate-limited, cannot take the question set, has spent the day's
//           budget, or when Clef's own answers show a possible policy hit
//           (a second predicate; the gate's is gatePolicyHit). With no Jev key,
//           Clef's answer stands; with no Clef credentials, Jev answers.
//
// One provider's answers per decision (review note 6): an escalation re-asks
// Jev every question and only Jev's answers are returned.
//
// Latency (note 5): Clef gets a sub-budget that always leaves room for a
// whole Jev call; a Clef timeout escalates and never fails open while Jev is
// there to answer.
//
// Shadow (note 12): when the caller samples a call, Jev is asked alongside
// Clef. A confident Clef answer is still the one used, and whether Jev's
// verdict agrees is returned so the board can show Clef's confident-error
// rate; if Clef escalates instead, Jev's answer is already on its way.

import { getScoreAnswer, type Answer, type CallJevOptions, type JevResponse, type JsonValue, type Question } from "./jev.ts";
import { CONSEQUENCE_NOISE_MARGIN, GATE_CONSEQUENCE_CEILING, POLICY_EFFECT_QUESTIONS } from "./decisions.ts";
import type { DecisionProvider, ProviderId } from "./decision_provider.ts";
import { clefFailureOf, neuronsFor, type ClefFailure, type ClefProvider } from "./clef.ts";

export const PROVIDER_MODES = ["jev", "clef", "both"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];
/** Review note 1: an upgrade changes nothing until the owner opts in. */
export const DEFAULT_PROVIDER_MODE: ProviderMode = "jev";

export function isProviderMode(value: unknown): value is ProviderMode {
  return typeof value === "string" && (PROVIDER_MODES as readonly string[]).includes(value);
}

/**
 * Why Jev answered in both mode.
 *   doubt        -- Clef answered, but the caller's doubt predicate held.
 *   failure      -- Clef failed (timeout, network, auth, 4xx, 5xx, bad body).
 *   rate-limit   -- Clef's per-moment limit (a 429 that is not the daily allowance).
 *   budget       -- the day's neuron budget is spent, by our ledger or Cloudflare's 3036.
 *   unsupported  -- the question set is outside Clef's limits (more than 64 questions, ...).
 *   policy       -- Clef answered, but the caller's policy-hit predicate held (a possible command-scoped policy hit).
 *   unconfigured -- no Clef credentials, so Jev is all there is.
 */
export const ESCALATIONS = ["doubt", "failure", "rate-limit", "budget", "unsupported", "policy", "unconfigured"] as const;
export type Escalation = (typeof ESCALATIONS)[number];

export function isEscalation(value: unknown): value is Escalation {
  return typeof value === "string" && (ESCALATIONS as readonly string[]).includes(value);
}

/** The gate's doubt band around its line, measured on 51 real commands (odd/tasks/multi-provider.md). */
export const GATE_DOUBT_BAND = 0.2;

/**
 * The gate's doubt: its verdict turns only on `consequence` against the
 * effective line, `ceiling - CONSEQUENCE_NOISE_MARGIN` (the destination's own
 * ceiling when it has one). Doubt is a score within GATE_DOUBT_BAND of that
 * line, or no consequence answer at all.
 */
export function gateConsequenceDoubt(answers: Record<string, Answer>, consequenceCeiling?: number): boolean {
  const consequence = getScoreAnswer(answers, "consequence");
  if (consequence === null) return true;
  const line = (consequenceCeiling ?? GATE_CONSEQUENCE_CEILING) - CONSEQUENCE_NOISE_MARGIN;
  return Math.abs(consequence.score - line) < GATE_DOUBT_BAND;
}

/**
 * The floor for a possible policy hit, measured on 56 real commands against
 * 24 policies (odd/tasks/clef-decides-policies.md): with it, Clef's verdicts
 * matched Jev's on every command; at 0.5, one did not.
 */
export const GATE_POLICY_HIT_FLOOR = 0.2;

/**
 * Whether Clef's answers show a possible policy hit: on any of `asked` that is
 * a policy question asked on effect (POLICY_EFFECT_QUESTIONS), an option other
 * than its none option has a probability of GATE_POLICY_HIT_FLOOR or more, or
 * Clef's own choice is not the none option. A policy question that was asked
 * and has no choice answer, or a probability that is not a finite number,
 * cannot be read, so it counts as a hit and Jev answers.
 */
export function gatePolicyHit(answers: Record<string, Answer>, asked: readonly string[]): boolean {
  return asked.some((id) => {
    const none = POLICY_EFFECT_QUESTIONS[id];
    if (none === undefined) return false;
    const answer = answers[id];
    if (answer === undefined || answer.type !== "choice" || answer.choice !== none) return true;
    return Object.entries(answer.probabilities).some(([option, probability]) => !Number.isFinite(probability) || (option !== none && probability >= GATE_POLICY_HIT_FLOOR));
  });
}

/**
 * A generic doubt for a caller with no measured one: a noul answer near even,
 * or a choice or score answer with low confidence. Unmeasured (note 11), so
 * no module but the gate cascades in this release.
 */
export function defaultDoubt(answers: Record<string, Answer>): boolean {
  return Object.values(answers).some((answer) => (answer.type === "noul" ? Math.abs(answer.noul - 0.5) < 0.15 : answer.confidence < 0.6));
}

/** The day's neuron budget as the cascade sees it (src/core/neuron_budget.ts behind it). */
export interface CascadeBudget {
  isOpen(): boolean;
  spend(neurons: number, model: string): void;
  /** Cloudflare said the daily allowance is spent (3036): Clef is skipped until 00:00 UTC. */
  markExhausted(): void;
}

export interface CascadeInput {
  readonly mode: ProviderMode;
  readonly jev: DecisionProvider | null;
  readonly clef: ClefProvider | null;
  readonly budget: CascadeBudget;
  readonly state: JsonValue;
  readonly questions: Record<string, Question>;
  readonly doubt: (answers: Record<string, Answer>) => boolean;
  /** The whole decision's latency budget. */
  readonly totalBudgetMs: number;
  /** Clef's share in both mode; the rest is kept for a whole Jev call. */
  readonly clefBudgetMs: number;
  /** Both mode: Clef's answer shows a possible policy hit, so Jev answers (escalation policy). Read after Clef's neurons are spent. */
  readonly policyHit?: ((answers: Record<string, Answer>) => boolean) | null;
  readonly shadow?: { readonly sampled: boolean; readonly verdictOf: (answers: Record<string, Answer>) => string } | null;
  /** Transport for both providers (fetchImpl/sleepImpl); budgetMs is set here. */
  readonly callOptions?: Omit<CallJevOptions, "budgetMs">;
  readonly nowImpl?: () => number;
}

export interface CascadeAnswer {
  readonly response: JevResponse;
  readonly provider: ProviderId;
  /** Why Jev answered in both mode; null when the mode's first provider answered. */
  readonly escalation: Escalation | null;
  /** Neurons this decision spent on Clef (0 when Clef was not asked or failed). */
  readonly neurons: number;
  /** For a sampled, confident Clef answer: whether Jev's verdict agreed. Null otherwise. */
  readonly shadowAgrees: boolean | null;
}

/** Clef was not asked because the day's budget is spent, and nobody else could answer. */
export class CascadeBudgetError extends Error {
  constructor() {
    super("Clef's daily neuron budget is spent");
    this.name = "CascadeBudgetError";
  }
}

function escalationFor(failure: ClefFailure): Escalation {
  if (failure.kind === "rate-limit") return "rate-limit";
  if (failure.kind === "daily-allowance") return "budget";
  if (failure.kind === "unsupported") return "unsupported";
  return "failure";
}

export async function runCascade(input: CascadeInput): Promise<CascadeAnswer> {
  const { mode, jev, clef, budget, state, questions } = input;
  const now = input.nowImpl ?? Date.now;
  const options = (budgetMs: number): CallJevOptions => ({ ...input.callOptions, budgetMs });
  const viaJev = async (provider: DecisionProvider, escalation: Escalation | null, pending?: Promise<JevResponse>, budgetMs = input.totalBudgetMs): Promise<CascadeAnswer> => ({
    response: await (pending ?? provider.ask(state, questions, options(budgetMs))),
    provider: "jev",
    escalation,
    neurons: 0,
    shadowAgrees: null,
  });

  if (mode === "jev") {
    if (jev === null) throw new Error("runCascade: Jev mode with no Jev provider");
    return viaJev(jev, null);
  }

  const fallback = mode === "both" ? jev : null;
  if (clef === null) {
    if (fallback === null) throw new Error("runCascade: no provider to ask");
    return viaJev(fallback, "unconfigured");
  }
  if (!budget.isOpen()) {
    if (fallback === null) throw new CascadeBudgetError();
    return viaJev(fallback, "budget");
  }

  const startedAt = now();
  const clefBudgetMs = fallback === null ? input.totalBudgetMs : Math.min(input.clefBudgetMs, input.totalBudgetMs);
  const reserveMs = input.totalBudgetMs - clefBudgetMs;
  // A sampled shadow call starts with Clef, so it costs no added latency.
  const shadowCall = fallback !== null && input.shadow?.sampled === true ? fallback.ask(state, questions, options(input.totalBudgetMs)) : null;
  // Never an unhandled rejection: whoever reads it handles the failure.
  shadowCall?.catch(() => undefined);
  const remaining = (): number => Math.max(reserveMs, input.totalBudgetMs - (now() - startedAt));

  let response: JevResponse;
  try {
    response = await clef.ask(state, questions, options(clefBudgetMs));
  } catch (error) {
    const failure = clefFailureOf(error);
    if (failure?.kind === "daily-allowance") budget.markExhausted();
    if (fallback === null) throw error;
    // Any Clef error, classified or not, is Jev's to answer while Jev is there (S2).
    return viaJev(fallback, failure === null ? "failure" : escalationFor(failure), shadowCall ?? undefined, remaining());
  }

  const neurons = neuronsFor(clef.model, response.usage);
  budget.spend(neurons, clef.model);

  if (fallback !== null && input.policyHit != null && input.policyHit(response.answers)) {
    return viaJev(fallback, "policy", shadowCall ?? undefined, remaining());
  }
  if (fallback !== null && input.doubt(response.answers)) {
    return viaJev(fallback, "doubt", shadowCall ?? undefined, remaining());
  }

  let shadowAgrees: boolean | null = null;
  if (shadowCall !== null && input.shadow !== undefined && input.shadow !== null) {
    try {
      const shadow = await shadowCall;
      shadowAgrees = input.shadow.verdictOf(shadow.answers) === input.shadow.verdictOf(response.answers);
    } catch {
      shadowAgrees = null;
    }
  }
  return { response, provider: "clef", escalation: null, neurons, shadowAgrees };
}
