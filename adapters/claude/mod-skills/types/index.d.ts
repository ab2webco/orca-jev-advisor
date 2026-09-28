// The mod-skills plugin's type contract: the values it keeps in `$.state`
// (session-scoped, surviving a hot reload), held by `claude plugin validate`
// against every `$.state` key hooks/index.ts names. Self-contained on
// purpose: a contract carries no import or reference.

/** An effort level as `turn.step` carries it. */
export type RouterStickyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

/**
 * The model router's sticky choice for this session (JEV-060 slice 2, §3):
 * set at session start (point A) or at a stage change (point C), reused on
 * every later main-loop step until the next stage decision changes it.
 */
export type RouterSticky = {
  /** What the router decided the session runs on (in measure mode: what it would run on). */
  model: string
  /** null = no effort sent (the model takes none). */
  effort: RouterStickyEffort | null
  /** Whether later steps are rewritten to `model`/`effort`: active mode AND a decided change. */
  rewrite: boolean
  /** The session's own model and effort, as `turn.step` named them when the router took over. */
  configuredModel: string
  configuredEffort: RouterStickyEffort | null
  /** The tier behind `model`; null when the router adopted the session's own (warm session, Jev failure). */
  tier: 'simple' | 'standard' | 'complex' | 'frontier' | null
  /** A lower tier waiting on hysteresis (§6.4): how many consecutive turns asked for it; with `effort`, a lower effort on the same model (0.6.2). */
  pendingLower: { tier: 'simple' | 'standard' | 'complex' | 'frontier'; turns: number; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } | null
  /** This session's own main-loop usage, for break-even (§6.4). */
  stats: RouterSessionStats
  /**
   * The last real prompt the router decided on: its text's hash (never the
   * text) and its position in the transcript. Point C runs only for a new
   * prompt: a turn the engine starts by itself (a subagent finished) has
   * none. Keyed on identity, not a count, so /compact cannot hide a new
   * prompt. null before any real prompt.
   */
  lastPrompt: { hash: string; position: number } | null
}

/** Main-loop usage of this session, kept by the router after every step. */
export type RouterSessionStats = {
  /** The turn the last recorded step belonged to. */
  turnId: string | null
  /** Steps seen so far in that turn. */
  turnSteps: number
  /** Steps of each completed turn, the most recent 20. */
  stepsPerTurn: number[]
  /** The last main step's input + cacheRead + cacheWrite + output. */
  lastContext: number | null
  outputTotal: number
  outputSteps: number
}

/**
 * JEV-061: the `kind` of the most recently submitted prompt's origin
 * (`PromptOrigin`, claude-code.d.ts), stamped by `prompt.submit` on every
 * submission -- before that hook's own early returns, so an empty prompt or
 * a slash command still updates it. Read at points A and C to tell a
 * person's own prompt from an engine- or agent-authored one (a task
 * notification, a scheduled trigger, a peer session, ...), which
 * `$.session.messages()` rows cannot say on their own.
 */
export type RouterPromptOrigin = {
  kind: string
}

/**
 * The context steward's count of this session's person turns and where it
 * last compacted (in measure mode: would have), for its cooldown of three
 * person turns between two compactions. A count of its own, not the
 * transcript's, so a compaction cannot reset it.
 */
export type StewardState = {
  /** Person prompts submitted this session (not slash commands, not empty ones). */
  personTurns: number
  /** `personTurns` at the last compaction; null before any. */
  lastCompactionTurn: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'orca-jev-mod-skills': { routerSticky: RouterSticky; routerPromptOrigin: RouterPromptOrigin; steward: StewardState }
  }
}
