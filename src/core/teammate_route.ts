// 0.6.20 T3: an agent-team teammate is routed at its first step. Claude Code
// creates a teammate when the lead calls the Agent tool with a `name` (no
// fork, no isolation); `agent.spawn` never fires for one (T1 probe), so the
// router never sees its task there. The lead's own Agent `tool.call` does
// carry it, and the teammate's first `turn.step` arrives before anything
// else about it. So the call's task is kept here, by name, until that step
// matches it.
//
// Pure: the hooks module holds the stash in memory (a reload forgets it, and
// a teammate with no task kept is not routed: its warm cache is left alone).

/** What the lead's Agent call asked of a teammate: what the spawn router reads. */
export interface TeammateTask {
  readonly name: string;
  /** The Agent call's `subagent_type`; null when it named none. */
  readonly subagentType: string | null;
  readonly description: string;
  readonly prompt: string;
  /** The Agent call's own `model` (an alias); null when it gave none. */
  readonly model: string | null;
}

/** The most tasks kept at once: teammates start within moments of the call, so a few is plenty. */
export const TEAMMATE_TASKS_MAX = 16;

/** The Agent call's fields that decide whether it makes a teammate. */
export interface AgentCallShape {
  readonly name?: string;
  readonly subagent_type?: string;
  readonly isolation?: string;
}

/** A named Agent call that is not a fork and asks for no isolation makes a teammate (T1 probe). */
export function isTeammateCall<T extends AgentCallShape>(call: T): call is T & { readonly name: string } {
  return typeof call.name === "string" && call.name.length > 0 && call.isolation === undefined && call.subagent_type !== "fork";
}

/** The stash with `task` added last: an earlier task of the same name goes, and the oldest go past TEAMMATE_TASKS_MAX. */
export function rememberTeammateTask(stash: readonly TeammateTask[], task: TeammateTask): TeammateTask[] {
  return [...stash.filter((kept) => kept.name !== task.name), task].slice(-TEAMMATE_TASKS_MAX);
}

/**
 * The task for a teammate as the host lists it: by its `name` when the host
 * gives one, else by the id the engine builds from it (`a<name>-<hex>`, the
 * T1 probe's). null when nothing matches.
 */
export function matchTeammateTask(stash: readonly TeammateTask[], agent: { readonly id: string; readonly name?: string }): TeammateTask | null {
  if (agent.name !== undefined) return stash.find((task) => task.name === agent.name) ?? null;
  const named = /^a(.+)-[0-9a-f]+$/.exec(agent.id);
  if (named === null) return null;
  return stash.find((task) => task.name === named[1]) ?? null;
}
