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
 * Track R (odd/tasks/router-cold-switch.md): the main thread's prompt-cache
 * clock. `ttlMs` is the bucket the newest main response wrote (1h or 5m, read
 * from the transcript tail at `classic.Stop`); `lastMainAt` is when the last
 * main-loop step answered. null where unknown, which counts as warm. Read
 * back through `parseCacheClock` (src/core/cache_warmth.ts).
 */
export type RouterCacheState = {
  ttlMs: number | null
  lastMainAt: number | null
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

/**
 * Track S (odd/tasks/steward-pre-cold.md): what the steward's pre-cold tier
 * keeps for the session. `judgment` is the turn-end steward's verdict on the
 * last turn, with the person-turn count it was given at (an older one is not
 * used); `headless` stops the tier arming in a headless (-p / SDK) session,
 * where the engine refuses compaction between turns.
 */
export type StewardColdState = {
  judgment: { verdict: 'boundary' | 'mid-task' | 'new-topic'; confidence: number; personTurns: number } | null
  headless: boolean
}

/**
 * 0.6.14 T1: the subagents running now, in the order they started, each as
 * `agent.spawn` recorded it (and `turn.step` updated its effort). Kept here
 * so a plugin reload in the same session does not forget them; pruned
 * against `$.agent.list()`. Read back through `parseRunningSubagents`
 * (src/core/subagent_status.ts), which drops anything malformed.
 */
export type RunningSubagentsState = {
  agents: {
    id: string
    type: string
    description: string
    /** The model as a person reads it (`Opus 5.5`). */
    label: string | null
    effort: RouterStickyEffort | null
    /** 0.6.15 T4b: a `SubagentEffortSource` (src/core/subagent_status.ts), null before its first step; absent on an older row. `frontmatter` since 0.6.16 T3. */
    effortSource?: 'inherited' | 'jev' | 'frontmatter' | 'not-sent' | null
    /** A `SubagentWhy` (src/core/subagent_status.ts). */
    why: string
    wouldUse: string | null
  }[]
}

/**
 * 0.9.0: the CI watcher's band rows (odd/tasks/ci-watcher.md): one per watch,
 * running or lately ended, as `ciBandRows` (src/core/ci_watch.ts) draws them.
 * Kept in `$.state` so a write redraws the band; a reload clears it at
 * session.start, since the watches themselves do not survive one. Read back
 * through `parseCiBandRows`, which drops anything malformed.
 */
export type CiWatchesState = {
  rows: {
    id: string
    /** The first seven characters of the commit. */
    sha7: string
    branch: string | null
    status: 'watching' | 'success' | 'failure'
    startedAtMs: number
    /** Runs finished and runs seen so far. */
    done: number
    total: number
    /** The workflows that did not succeed. */
    failed: string[]
    /** The workflows still running. */
    running: string[]
    /** How long `typicalWorkflow` usually takes (median of its last successful runs); both null when unknown. */
    typicalWorkflow: string | null
    typicalSeconds: number | null
    /** How long the runs took, once finished. */
    durationMs: number | null
    finishedAtMs: number | null
  }[]
}

/**
 * The memory module's backend for this session (odd/tasks/memory-shadow.md,
 * M8), as src/core/memory_detect.ts decided it: at session start, and once
 * more at the first turn when the start found no live Engram (MCP servers can
 * connect late). The health call (`mem_current_project`) is made at most once
 * a session; its outcome is kept so a re-check does not repeat it.
 */
export type MemoryShadowState = {
  backend: 'live' | 'configured-down' | 'absent'
  decidedBy: 'tools+health' | 'tools' | 'health' | 'user-config' | 'plugin' | 'binary' | 'none'
  /** The Engram MCP server to call, null when Engram cannot be called. */
  server: string | null
  permission: 'ok' | 'refused' | 'unknown'
  /** Where the backend was last decided. */
  detectedAt: 'start' | 'turn'
  /** The health call's outcome; null when it was not made. */
  health: 'ok' | 'permission' | 'failed' | null
  /** A turn already looked again after the start found no live Engram. */
  rechecked: boolean
}

/**
 * Game mode (odd/tasks/game-mode-advisor-state.md): written only in a pane
 * Orca launched with its `orca-game` mod (ORCA_GAME_MODE `on` or `zen`), where
 * Jev draws neither its status line nor its band. The game reads this value
 * and draws it. Never written without the game. Built by
 * src/core/advisor_state.ts (`buildAdvisorState`). Every absent value is null.
 */
export type AdvisorState = {
  version: 1
  locale: 'es' | 'en'
  /** The status line Jev would show (`jev · …`); null when it would show none. */
  line: string | null
  /** The main conversation's model as a person reads it (`Opus 5.5`), its id, and its effort; null before the router decided or with it off. */
  model: string | null
  modelId: string | null
  effort: RouterStickyEffort | null
  /** The agents running now, as the band's rows. */
  subagents: readonly {
    id: string
    type: string
    /** The Agent call's description. */
    title: string
    branch: string | null
    /** The worktree's directory name, only when it is not the lead's. */
    worktree: string | null
    model: string | null
    effort: RouterStickyEffort | null
    status: 'running'
    why: 'explicit' | 'lowered' | 'raised' | 'chosen' | 'same' | 'kept-unsure' | 'kept-pointer' | 'kept-pinned' | 'measuring' | 'inherited' | 'no-jev' | 'teammate' | 'teammate-routed' | 'before-load' | 'unseen'
    /** The short reason, translated (`Jev duda`). */
    verdict: string
  }[]
  /** The CI watches the band shows, each with its band line (`text`). */
  ci: readonly {
    id: string
    sha7: string
    branch: string | null
    status: 'watching' | 'success' | 'failure'
    done: number
    total: number
    failed: readonly string[]
    running: readonly string[]
    text: string
    startedAtMs: number
    finishedAtMs: number | null
  }[]
  /** The mod's toasts (the steward's /clear hint, a finished CI run), newest last, at most 5; the toasts still show. */
  notices: readonly { id: string; level: 'info' | 'warn' | 'block'; text: string; at: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'orca-jev-mod-skills': { routerSticky: RouterSticky; routerPromptOrigin: RouterPromptOrigin; routerCache: RouterCacheState; steward: StewardState; stewardCold: StewardColdState; runningSubagents: RunningSubagentsState; ciWatches: CiWatchesState; memory: MemoryShadowState; advisor: AdvisorState }
  }
}
