// feature-modules T0 (odd/tasks/feature-modules.md): what each feature module
// costs today, so a later task can show that a module switched off costs zero.
//
// Three costs per module:
//   - hook process spawns: Claude Code starts one process per settings.json
//     hook that matches a tool call. Derived from the tool calls seen in the
//     transcripts and the hooks installed now; the gate's Bash hook is also
//     timed where a transcript records it (only runs that print something).
//   - Jev calls: counted from each module's own log, row by row, with the
//     rule each row's writer follows (one row is not always one call).
//   - worker work: the timers and handlers of adapters/orca/main.mjs
//     (cadence derived from its constants), and the `storage.set` writes
//     Orca's plugin audit log observed for each of them.
//
// Pure: rows and lines in, a report out. scripts/measure-module-cost.mjs
// reads the files. Nothing here prints transcript content: only counts and
// timings leave this module.

import { isRecord } from "../guards.ts";
import { classifyAgentCall, sleepSeconds, summarizeCiWatchRows } from "./ci_watch.ts";
import type { CiWatchSummary } from "./ci_watch.ts";
import { summarizeStewardActivity } from "./context_steward.ts";
import type { ActivityMessage } from "./model_router_stage.ts";
import { wideBatches } from "./tool_decisions.ts";
import { isVerifyDoneCandidate, summarizeVerifyDoneDecisions } from "./verify_done.ts";
import { summarizeMemoryDecisions } from "./memory_shadow.ts";

export type ModuleId = "gate" | "model-router" | "steward" | "skill-selection" | "board" | "verify-done" | "ci-watch";

export const MODULE_IDS: readonly ModuleId[] = ["gate", "model-router", "steward", "skill-selection", "board", "verify-done", "ci-watch"];

export interface TimeWindow {
  readonly sinceMs: number;
  readonly untilMs: number;
}

/** Jev calls one log row stands for. */
export interface JevCallCount {
  readonly calls: number;
  readonly failures: number;
  /** One entry per call whose latency the row logs. */
  readonly latencyMs: readonly number[];
}

const NONE: JevCallCount = { calls: 0, failures: 0, latencyMs: [] };

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latencies(...values: unknown[]): number[] {
  return values.map(numberOrNull).filter((value): value is number => value !== null);
}

/** Nearest-rank percentile (same convention as gate_stats.ts): always a recorded value; null with no sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1);
  return sorted[index] ?? null;
}

/**
 * gate-bash.ts: a `jev` row asked Jev once (the policy and risk questions
 * share one call); `none` + `unreachable` is a call that failed. Cache and
 * local-rule rows asked nothing. An identical retry (`advice-retry`) is
 * recorded as `jev` too, but main() passes it before any Jev call, with no
 * latency (tryAdviceRetryPass); only one that carries a latency followed a call.
 */
export function gateJevCalls(row: unknown): JevCallCount {
  if (!isRecord(row)) return NONE;
  if (row["source"] === "jev" && row["stopReason"] === "advice-retry" && numberOrNull(row["latencyMs"]) === null) return NONE;
  if (row["source"] === "jev") return { calls: 1, failures: 0, latencyMs: latencies(row["latencyMs"]) };
  if (row["source"] === "none" && row["stopReason"] === "unreachable") return { calls: 1, failures: 1, latencyMs: latencies(row["latencyMs"]) };
  return NONE;
}

function latencyPair(row: Record<string, unknown>): { wide: number | null; fit: number | null } {
  const latency = row["latencyMs"];
  if (!isRecord(latency)) return { wide: null, fit: null };
  return { wide: numberOrNull(latency["wide"]), fit: numberOrNull(latency["fit"]) };
}

function stagedCalls(row: unknown, wideCalls: (row: Record<string, unknown>) => number): JevCallCount {
  if (!isRecord(row) || row["type"] !== "decision") return NONE;
  const { wide, fit } = latencyPair(row);
  const wideCount = wide === null ? 0 : wideCalls(row);
  const fitCount = fit === null ? 0 : 1;
  const failures = (wide !== null && row["wide"] === null ? 1 : 0) + (fit !== null && row["fit"] === null ? 1 : 0);
  return { calls: wideCount + fitCount, failures, latencyMs: latencies(wide, fit) };
}

/** mod-skills: the wide stage is one call; the fit stage one more when it ran (its latency is logged). A null result after a call is a failure. */
export function skillJevCalls(row: unknown): JevCallCount {
  return stagedCalls(row, () => 1);
}

/** mod-tools: the wide stage asks one call per batch of the roster (wideBatches); the fit stage one more when it ran. */
export function toolJevCalls(row: unknown): JevCallCount {
  return stagedCalls(row, (record) => {
    const count = numberOrNull(record["candidateCount"]) ?? 0;
    return Math.max(wideBatches(Array.from({ length: count }, (_, index) => ({ name: String(index), description: "" }))).length, 1);
  });
}

/**
 * model-router-decisions: a row Jev answered carries its confidence; a
 * `jev-failed` or `jev-payment` (G8: a 402) row is a call that failed. An engine-started turn
 * (routeEngineTurn) writes a row with neither and asked nothing. A failed
 * call whose guards restored the floor also has neither, so it reads as no
 * call (a possible undercount of failures, never of answers).
 */
export function routerJevCalls(row: unknown): JevCallCount {
  if (!isRecord(row)) return NONE;
  if (row["reason"] === "jev-failed" || row["reason"] === "jev-payment") return { calls: 1, failures: 1, latencyMs: [] };
  if (numberOrNull(row["confidence"]) !== null) return { calls: 1, failures: 0, latencyMs: [] };
  return NONE;
}

/** The fail-open reasons (model_measurement.ts) that come after a request to Jev was sent; the others give up before any call. */
const MODEL_FAIL_OPEN_AFTER_CALL: readonly string[] = ["jev-unreachable", "auth-rejected", "unparseable-answer"];

/** model-reclassifications (agent-model.ts): a `jev` decision row is one call; a `none` row is one failed call only when it failed after asking. Outcome rows asked nothing. */
export function modelDecisionJevCalls(row: unknown): JevCallCount {
  if (!isRecord(row) || row["type"] !== "model-decision") return NONE;
  if (row["source"] === "jev") return { calls: 1, failures: 0, latencyMs: latencies(row["latencyMs"]) };
  const failOpen = row["failOpen"];
  if (typeof failOpen === "string" && MODEL_FAIL_OPEN_AFTER_CALL.includes(failOpen)) return { calls: 1, failures: 1, latencyMs: latencies(row["latencyMs"]) };
  return NONE;
}

/** context-steward-decisions: the steward logs only turns it asked Jev about, one call each; a null verdict is a failed call. */
export function stewardJevCalls(row: unknown): JevCallCount {
  if (!isRecord(row)) return NONE;
  return { calls: 1, failures: row["verdict"] === null || row["verdict"] === undefined ? 1 : 0, latencyMs: [] };
}

/** verify-done-decisions (0.8.0): one row per candidate turn, each one call; a `jev-failed` row is a failed call. The row logs the call's latency. */
export function verifyDoneJevCalls(row: unknown): JevCallCount {
  if (!isRecord(row)) return NONE;
  return { calls: 1, failures: row["decision"] === "jev-failed" ? 1 : 0, latencyMs: latencies(row["latencyMs"]) };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface InstalledHook {
  readonly event: string;
  readonly matcher: string;
  readonly script: string;
  readonly module: ModuleId;
}

/** Our hook scripts and the module each belongs to (the task file's table). */
const HOOK_SCRIPTS: ReadonlyArray<readonly [string, ModuleId]> = [
  ["gate-bash", "gate"],
  ["gate-outcome", "gate"],
  ["gate-files", "gate"],
  ["agent-model", "model-router"],
];

const OUR_STATUS_PREFIX = "orca-jev-advisor:";

function scriptOf(hook: Record<string, unknown>): string | null {
  const args = Array.isArray(hook["args"]) ? hook["args"].filter((arg): arg is string => typeof arg === "string") : [];
  const command = typeof hook["command"] === "string" ? hook["command"] : "";
  const words = [command, ...args].join(" ");
  for (const [script] of HOOK_SCRIPTS) {
    if (new RegExp(`(^|[/\\\\\\s])${script}\\.(ts|mjs)\\b`).test(words)) return script;
  }
  return null;
}

/** This plugin's hooks in one settings.json: the entries whose status message is ours and whose script is one of ours. */
export function ourHooksFromSettings(settings: unknown): InstalledHook[] {
  if (!isRecord(settings) || !isRecord(settings["hooks"])) return [];
  const found: InstalledHook[] = [];
  for (const [event, groups] of Object.entries(settings["hooks"])) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group["hooks"])) continue;
      const matcher = typeof group["matcher"] === "string" ? group["matcher"] : "";
      for (const hook of group["hooks"]) {
        if (!isRecord(hook) || typeof hook["statusMessage"] !== "string" || !hook["statusMessage"].startsWith(OUR_STATUS_PREFIX)) continue;
        const script = scriptOf(hook);
        const module = HOOK_SCRIPTS.find(([name]) => name === script)?.[1];
        if (script === null || module === undefined) continue;
        found.push({ event, matcher, script, module });
      }
    }
  }
  return found;
}

function matches(matcher: string, tool: string): boolean {
  if (matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
}

function emptyByModule(): Record<ModuleId, number> {
  return { gate: 0, "model-router": 0, steward: 0, "skill-selection": 0, board: 0, "verify-done": 0, "ci-watch": 0 };
}

/**
 * Processes Claude Code starts for our hooks: PreToolUse once per matching
 * call, PostToolUse once per call that succeeded, PostToolUseFailure once
 * per call that failed. PermissionDenied fires on a permission refusal the
 * transcript does not tell apart, so it counts 0 here. The same hook
 * installed in several settings files (one per account) counts once: a
 * session reads only its own.
 */
export function derivedHookSpawns(hooks: readonly InstalledHook[], toolCalls: ReadonlyMap<string, number>, toolErrors: ReadonlyMap<string, number>): Record<ModuleId, number> {
  const spawns = emptyByModule();
  const seen = new Set<string>();
  for (const hook of hooks) {
    const key = `${hook.event}\u0000${hook.matcher}\u0000${hook.script}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [tool, calls] of toolCalls) {
      if (!matches(hook.matcher, tool)) continue;
      const errors = Math.min(toolErrors.get(tool) ?? 0, calls);
      if (hook.event === "PreToolUse") spawns[hook.module] += calls;
      else if (hook.event === "PostToolUse") spawns[hook.module] += calls - errors;
      else if (hook.event === "PostToolUseFailure") spawns[hook.module] += errors;
    }
  }
  return spawns;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export interface TranscriptTally {
  readonly toolCalls: Map<string, number>;
  readonly toolErrors: Map<string, number>;
  /** Person prompts on the main thread, deduplicated by uuid. */
  prompts: number;
  /** Completed main turns (`system/turn_duration`), deduplicated by uuid. */
  turns: number;
  /** Duration of the gate's PreToolUse:Bash hook, one per tool call, where the transcript records it. */
  readonly gateBashHookMs: number[];
  /** Our hooks Claude Code cancelled (timeout), one per tool call. */
  gateHookCancelled: number;
  readonly seenToolUse: Map<string, string>;
  readonly seenErrors: Set<string>;
  readonly seenUuids: Set<string>;
  readonly seenHookRuns: Set<string>;
  /** verify-done (0.8.0): main-thread person turns closed so far (by the next prompt, or finishTranscriptTally). */
  verifyDoneTurns: number;
  /** The closed turns verify-done's own rule (isVerifyDoneCandidate) would ask Jev about. */
  verifyDoneCandidates: number;
  /** Each session's open turn: its prompt and its tool calls, a result's text and error folded into its call. */
  readonly openTurns: Map<string, OpenTurn>;
  /** ci-watch (0.9.0): main-thread Bash calls that poll CI (gh run list|view|watch, gh pr checks), by the module's own predicate. */
  ciPolls: number;
  /** Main-thread sleeps of 10 s or more that are no CI poll: what the module counts as a sleep a note would replace. */
  ciSleeps: number;
  /** Every main-thread Bash call that sleeps, whatever its length or company: the baseline's reading of "sleep". */
  anySleeps: number;
  /** Memory (M15): the main thread's Engram calls, by tool (`mem_save`), either server spelling. */
  readonly engramCalls: Map<string, number>;
  /** Memory (M15): each main-thread response (message.id) that called Engram, its Engram tools and its other tool calls. */
  readonly engramResponses: Map<string, EngramResponse>;
}

interface EngramResponse {
  readonly engram: Set<string>;
  other: number;
}

const ENGRAM_TOOL_NAME = /^mcp__(?:engram|plugin_engram_engram)__(\w+)$/;

interface OpenToolUse {
  readonly tool_use_id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  text?: string;
  isError?: true;
}

interface OpenTurn {
  readonly prompt: string;
  readonly toolUses: OpenToolUse[];
}

export function newTranscriptTally(): TranscriptTally {
  return {
    toolCalls: new Map(),
    toolErrors: new Map(),
    prompts: 0,
    turns: 0,
    gateBashHookMs: [],
    gateHookCancelled: 0,
    seenToolUse: new Map(),
    seenErrors: new Set(),
    seenUuids: new Set(),
    seenHookRuns: new Set(),
    verifyDoneTurns: 0,
    verifyDoneCandidates: 0,
    openTurns: new Map(),
    ciPolls: 0,
    ciSleeps: 0,
    anySleeps: 0,
    engramCalls: new Map(),
    engramResponses: new Map(),
  };
}

/**
 * Folds one new main-thread tool call into its response. A response is its
 * message.id: Claude Code writes one line per content block, so lines would
 * count one response several times. Only responses that call Engram are kept.
 */
function tallyEngramCall(tally: TranscriptTally, entry: Record<string, unknown>, messageId: string | null, tool: string): void {
  if (entry["type"] !== "assistant" || entry["isSidechain"] === true || messageId === null) return;
  const engram = ENGRAM_TOOL_NAME.exec(tool);
  const response = tally.engramResponses.get(messageId);
  if (engram !== null && engram[1] !== undefined) {
    bump(tally.engramCalls, engram[1]);
    const kept = response ?? { engram: new Set<string>(), other: 0 };
    kept.engram.add(engram[1]);
    tally.engramResponses.set(messageId, kept);
  } else if (response !== undefined) {
    response.other += 1;
  } else {
    tally.engramResponses.set(messageId, { engram: new Set<string>(), other: 1 });
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function inWindow(window: TimeWindow, ms: number): boolean {
  return Number.isFinite(ms) && ms >= window.sinceMs && ms < window.untilMs;
}

function isPersonPrompt(entry: Record<string, unknown>): boolean {
  if (entry["isMeta"] === true || entry["isCompactSummary"] === true || entry["isSidechain"] === true) return false;
  const message = entry["message"];
  if (!isRecord(message)) return false;
  const content = message["content"];
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((part) => isRecord(part) && part["type"] === "tool_result")) return false;
    text = content.map((part) => (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? part["text"] : "")).join("");
  }
  const trimmed = text.trim();
  // Command wrappers, task notifications and local command output are not a person's prompt.
  return trimmed.length > 0 && !trimmed.startsWith("<");
}

/** ci-watch: a main-thread Bash call that polls CI or sleeps, by the predicates the module itself counts with. */
function tallyCiWait(tally: TranscriptTally, entry: Record<string, unknown>, part: Record<string, unknown>): void {
  if (part["name"] !== "Bash" || entry["isSidechain"] === true) return;
  const input = part["input"];
  const command = isRecord(input) && typeof input["command"] === "string" ? input["command"] : null;
  if (command === null) return;
  const kind = classifyAgentCall("Bash", command);
  if (kind === "ci-poll") tally.ciPolls += 1;
  else if (kind === "sleep") tally.ciSleeps += 1;
  if (sleepSeconds(command) !== null) tally.anySleeps += 1;
}

function tallyContent(tally: TranscriptTally, entry: Record<string, unknown>): void {
  const message = entry["message"];
  if (!isRecord(message) || !Array.isArray(message["content"])) return;
  const messageId = typeof message["id"] === "string" ? message["id"] : null;
  for (const part of message["content"]) {
    if (!isRecord(part)) continue;
    if (part["type"] === "tool_use" && typeof part["id"] === "string" && typeof part["name"] === "string") {
      if (tally.seenToolUse.has(part["id"])) continue;
      tally.seenToolUse.set(part["id"], part["name"]);
      bump(tally.toolCalls, part["name"]);
      tallyCiWait(tally, entry, part);
      tallyEngramCall(tally, entry, messageId, part["name"]);
    } else if (part["type"] === "tool_result" && part["is_error"] === true && typeof part["tool_use_id"] === "string") {
      if (tally.seenErrors.has(part["tool_use_id"])) continue;
      tally.seenErrors.add(part["tool_use_id"]);
      const name = tally.seenToolUse.get(part["tool_use_id"]);
      if (name !== undefined) bump(tally.toolErrors, name);
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : "")).join("\n");
}

/** Closes a session's open turn: one person turn, and a candidate when verify-done's own rule says so. */
function closeTurn(tally: TranscriptTally, session: string): void {
  const turn = tally.openTurns.get(session);
  if (turn === undefined) return;
  tally.openTurns.delete(session);
  const messages: ActivityMessage[] = [
    { role: "user", text: turn.prompt, toolUses: [] },
    { role: "assistant", text: "", toolUses: turn.toolUses },
  ];
  tally.verifyDoneTurns += 1;
  if (isVerifyDoneCandidate(summarizeStewardActivity(messages))) tally.verifyDoneCandidates += 1;
}

/** Follows the main thread's turns for verify-done: a person prompt opens one, tool calls and their results fill it. */
function tallyVerifyDoneTurn(tally: TranscriptTally, entry: Record<string, unknown>, personPrompt: boolean): void {
  if (entry["isSidechain"] === true || typeof entry["sessionId"] !== "string") return;
  const session = entry["sessionId"];
  if (personPrompt) {
    closeTurn(tally, session);
    tally.openTurns.set(session, { prompt: "person prompt", toolUses: [] });
    return;
  }
  const turn = tally.openTurns.get(session);
  const message = entry["message"];
  if (turn === undefined || !isRecord(message) || !Array.isArray(message["content"])) return;
  for (const part of message["content"]) {
    if (!isRecord(part)) continue;
    if (part["type"] === "tool_use" && typeof part["id"] === "string" && typeof part["name"] === "string") {
      if (turn.toolUses.some((use) => use.tool_use_id === part["id"])) continue;
      turn.toolUses.push({ tool_use_id: part["id"], tool: part["name"], input: isRecord(part["input"]) ? part["input"] : {} });
    } else if (part["type"] === "tool_result" && typeof part["tool_use_id"] === "string") {
      const use = turn.toolUses.find((candidate) => candidate.tool_use_id === part["tool_use_id"]);
      if (use === undefined) continue;
      use.text = resultText(part["content"]);
      if (part["is_error"] === true) use.isError = true;
    }
  }
}

/** Closes every turn still open once all transcript lines are read: the last turn of each session counts too. Idempotent. */
export function finishTranscriptTally(tally: TranscriptTally): void {
  for (const session of [...tally.openTurns.keys()]) closeTurn(tally, session);
}

function tallyHook(tally: TranscriptTally, attachment: Record<string, unknown>): void {
  const command = attachment["command"];
  if (typeof command !== "string" || !command.startsWith(OUR_STATUS_PREFIX)) return;
  const toolUseId = typeof attachment["toolUseID"] === "string" ? attachment["toolUseID"] : "";
  const key = `${String(attachment["type"])}\u0000${String(attachment["hookName"])}\u0000${toolUseId}`;
  if (toolUseId !== "" && tally.seenHookRuns.has(key)) return;
  tally.seenHookRuns.add(key);
  if (attachment["type"] === "hook_cancelled") {
    tally.gateHookCancelled += 1;
    return;
  }
  const duration = numberOrNull(attachment["durationMs"]);
  if (attachment["type"] === "hook_success" && attachment["hookName"] === "PreToolUse:Bash" && duration !== null) tally.gateBashHookMs.push(duration);
}

/** Folds one transcript JSONL line into the tally; a line outside the window or not JSON is skipped. */
export function tallyTranscriptLine(tally: TranscriptTally, line: string, window: TimeWindow): void {
  if (line.length === 0) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(entry) || typeof entry["timestamp"] !== "string" || !inWindow(window, Date.parse(entry["timestamp"]))) return;
  const uuid = typeof entry["uuid"] === "string" ? entry["uuid"] : null;
  const type = entry["type"];
  if (type === "assistant" || type === "user") tallyContent(tally, entry);
  const newPrompt = type === "user" && uuid !== null && isPersonPrompt(entry) && !tally.seenUuids.has(uuid);
  if (type === "assistant" || type === "user") tallyVerifyDoneTurn(tally, entry, newPrompt);
  if (newPrompt) {
    tally.seenUuids.add(uuid);
    tally.prompts += 1;
  }
  if (type === "system" && entry["subtype"] === "turn_duration" && uuid !== null && !tally.seenUuids.has(uuid)) {
    tally.seenUuids.add(uuid);
    tally.turns += 1;
  }
  if (type === "attachment" && isRecord(entry["attachment"])) tallyHook(tally, entry["attachment"]);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface WorkerTask {
  readonly id: string;
  /** `interval` or `event: <name>`, as adapters/orca/main.mjs registers it. */
  readonly trigger: string;
  /** Null for an event handler. */
  readonly intervalMs: number | null;
  /** Node sidecars (child processes) one run spawns. */
  readonly sidecarsPerRun: number;
  /** Other child processes one run may spawn. */
  readonly otherSpawns: string;
  /** The module that owns it, `shared` when several read it, `base` for the plugin itself. */
  readonly owner: ModuleId | "shared" | "base";
  readonly modules: readonly ModuleId[];
  /** The storage key whose writes the audit log shows for each run; null when it writes none. */
  readonly auditKey: string | null;
}

const MINUTE = 60_000;

/**
 * The worker's timers and handlers, DERIVED from adapters/orca/main.mjs
 * (activate(): MEASUREMENTS_REFRESH_MS, ACCOUNT_QUOTA_REFRESH_MS,
 * CONSUMPTION_REFRESH_MS, ACTIVITY_REFRESH_MS, SECRET_POLL_*_MS and the
 * three orca.events.on subscriptions). Kept by hand: main.mjs is the worker
 * entry and is not imported here.
 */
export const WORKER_TASKS: readonly WorkerTask[] = [
  { id: "measurements summary", trigger: "interval", intervalMs: 15_000, sidecarsPerRun: 1, otherSpawns: "", owner: "shared", modules: ["gate", "skill-selection"], auditKey: "measurementsSummary" },
  { id: "model measurements", trigger: "interval", intervalMs: 15_000, sidecarsPerRun: 1, otherSpawns: "", owner: "model-router", modules: ["model-router"], auditKey: "modelMeasurements" },
  { id: "gate authorizations", trigger: "interval", intervalMs: 15_000, sidecarsPerRun: 1, otherSpawns: "", owner: "gate", modules: ["gate"], auditKey: "gateAuthorizationsStatus" },
  { id: "account quota mirror", trigger: "interval", intervalMs: 10 * MINUTE, sidecarsPerRun: 1, otherSpawns: "orca account list (shared 30 s)", owner: "model-router", modules: ["model-router"], auditKey: null },
  { id: "router status", trigger: "interval", intervalMs: 10 * MINUTE, sidecarsPerRun: 0, otherSpawns: "orca account list (shared 30 s)", owner: "model-router", modules: ["model-router"], auditKey: "modelRouterStatus" },
  { id: "model docs check", trigger: "interval", intervalMs: 10 * MINUTE, sidecarsPerRun: 0, otherSpawns: "one fetch a day", owner: "model-router", modules: ["model-router"], auditKey: "modelsDocsCheck" },
  { id: "consumption summary", trigger: "interval", intervalMs: 10 * MINUTE, sidecarsPerRun: 1, otherSpawns: "orca account list (shared 30 s)", owner: "shared", modules: ["model-router", "steward"], auditKey: "consumptionSummary" },
  { id: "activity summary", trigger: "interval", intervalMs: 10 * MINUTE, sidecarsPerRun: 1, otherSpawns: "", owner: "shared", modules: ["gate", "model-router"], auditKey: "activityByProjectSummary" },
  { id: "agent status board", trigger: "event: agent.status.changed", intervalMs: null, sidecarsPerRun: 0, otherSpawns: "orca worktree list + orca repo list (cached 30 s)", owner: "board", modules: ["board"], auditKey: "board" },
  { id: "worktree created", trigger: "event: worktree.created", intervalMs: null, sidecarsPerRun: 0, otherSpawns: "", owner: "board", modules: ["board"], auditKey: null },
  { id: "worktree removed", trigger: "event: worktree.removed", intervalMs: null, sidecarsPerRun: 0, otherSpawns: "", owner: "board", modules: ["board"], auditKey: null },
  { id: "request poll + heartbeat", trigger: "interval", intervalMs: 15_000, sidecarsPerRun: 0, otherSpawns: "1 s while the panel is open", owner: "base", modules: [], auditKey: "workerHeartbeat" },
];

export interface AuditSets {
  /** Timestamps of each storage key's successful writes, in order. */
  readonly times: Map<string, number[]>;
  readonly firstMs: number | null;
  readonly lastMs: number | null;
}

/** Orca's plugin audit log: `storage.set` writes by `actor` that succeeded (`ok`; each write also logs an `attempt`), by storage key. */
export function auditSetsByKey(lines: readonly string[], actor: string, window: TimeWindow): AuditSets {
  const times = new Map<string, number[]>();
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const line of lines) {
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row) || row["actor"] !== actor || row["method"] !== "storage.set" || row["outcome"] !== "ok") continue;
    const ts = numberOrNull(row["ts"]);
    if (ts === null || !inWindow(window, ts)) continue;
    const match = /^key=([A-Za-z0-9_-]+)/.exec(typeof row["summary"] === "string" ? row["summary"] : "");
    if (match === null || match[1] === undefined) continue;
    const list = times.get(match[1]) ?? [];
    list.push(ts);
    times.set(match[1], list);
    firstMs = firstMs === null ? ts : Math.min(firstMs, ts);
    lastMs = lastMs === null ? ts : Math.max(lastMs, ts);
  }
  for (const list of times.values()) list.sort((a, b) => a - b);
  return { times, firstMs, lastMs };
}

/** How many events found the board's 30 s `orca` CLI cache expired, and so spawned the CLI. */
export function boardCliRefreshes(eventTimesMs: readonly number[], cacheMs: number): number {
  let refreshes = 0;
  let last: number | null = null;
  for (const at of [...eventTimesMs].sort((a, b) => a - b)) {
    if (last === null || at - last >= cacheMs) {
      refreshes += 1;
      last = at;
    }
  }
  return refreshes;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ModuleRows {
  readonly gate: readonly unknown[];
  readonly skills: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly router: readonly unknown[];
  readonly models: readonly unknown[];
  readonly steward: readonly unknown[];
  readonly verifyDone: readonly unknown[];
  readonly ciWatch: readonly unknown[];
  /** memory-decisions (odd/tasks/memory-shadow.md). */
  readonly memory: readonly unknown[];
}

export interface ModuleCostInput {
  readonly window: TimeWindow;
  readonly tally: TranscriptTally;
  readonly hooks: readonly InstalledHook[];
  readonly rows: ModuleRows;
  readonly audit: AuditSets;
}

export interface ModuleCostRow {
  readonly module: ModuleId;
  /** Derived: tool calls x installed hooks. */
  readonly hookSpawns: number;
  readonly hookSpawnsPerToolCall: number | null;
  /** Observed: transcript hook durations (gate's Bash hook only). */
  readonly hookMsP50: number | null;
  readonly hookMsP90: number | null;
  readonly hookTimed: number;
  readonly jevCalls: number;
  readonly jevFailures: number;
  readonly jevPerPrompt: number | null;
  readonly jevPerTurn: number | null;
  readonly jevMsP50: number | null;
  readonly jevMsP90: number | null;
  readonly jevTimed: number;
}

export interface WorkerRow {
  readonly id: string;
  readonly trigger: string;
  readonly owner: WorkerTask["owner"];
  readonly modules: readonly ModuleId[];
  readonly auditKey: string | null;
  readonly derivedPerHour: number | null;
  readonly observedPerHour: number | null;
  readonly sidecarsPerHour: number | null;
  readonly otherSpawns: string;
}

export interface ModuleCostReport {
  readonly window: TimeWindow;
  readonly prompts: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly modules: readonly ModuleCostRow[];
  /** Rows per `mode` value of each mod log, so measurement and active are never mixed up. */
  readonly modes: { readonly skills: Record<string, number>; readonly tools: Record<string, number>; readonly steward: Record<string, number> };
  readonly agentSpawns: { readonly agentCalls: number; readonly reclassifications: number; readonly routerSubagentRows: number };
  readonly audit: { readonly firstMs: number | null; readonly lastMs: number | null; readonly spanHours: number | null; readonly boardCliRefreshesPerHour: number | null };
  readonly worker: readonly WorkerRow[];
  /**
   * verify-done (0.8.0): from its own log, the turns a blocking state would
   * have stopped (would-block); from the transcripts, the person turns its
   * rule makes candidates -- what shadow costs before any row exists.
   */
  readonly verifyDone: {
    readonly decisions: number;
    readonly claims: number;
    readonly wouldBlock: number;
    readonly jevFailed: number;
    readonly candidateTurns: number;
    readonly personTurns: number;
    readonly candidatesPerPrompt: number | null;
  };
  /**
   * ci-watch (0.9.0): from its own log, the watches that ended in the window and
   * what the agent spent waiting during them; from the transcripts, the main
   * thread's CI polls and sleeps in the whole window, counted with the same
   * predicates, so the 580 and 800 a week it was built for can be compared.
   */
  readonly ciWatch: CiWatchSummary & {
    readonly mainThreadPolls: number;
    readonly mainThreadLongSleeps: number;
    readonly mainThreadSleeps: number;
  };
  /**
   * memory (odd/tasks/memory-shadow.md, M15). Not a row of the Jev table: it
   * calls Haiku and forks, never Jev. From the transcripts, what the main
   * thread spends on Engram today (the steps an Active module would remove);
   * from its own log, what the module spends in the background.
   */
  readonly memory: MemoryCost;
}

export interface MemoryCost {
  /** Main-thread Engram calls by tool (`mem_save`, `mem_judge`, ...). */
  readonly engramCalls: Readonly<Record<string, number>>;
  readonly engramCallTotal: number;
  readonly engramCallsPerPrompt: number | null;
  /** Main-thread responses (by message.id) with at least one Engram call. */
  readonly responsesWithEngram: number;
  /** ...whose tool calls were all Engram calls: the removable steps. */
  readonly engramOnlyResponses: number;
  readonly engramOnlySaveResponses: number;
  /** Engram-only responses with a mem_judge and no mem_save. */
  readonly engramOnlyJudgeOnlyResponses: number;
  /** Haiku gate calls: one per row. */
  readonly gates: number;
  readonly gateFailures: number;
  readonly updates: number;
  readonly gatesPerPrompt: number | null;
  readonly forks: number;
  readonly forksPerPrompt: number | null;
  /** Judge prompts built and never asked (Shadow). */
  readonly judgeBuilds: number;
  readonly judgeBuildsPerPrompt: number | null;
  readonly haikuTokens: { readonly input: number; readonly output: number };
  readonly forkTokens: { readonly input: number; readonly output: number; readonly cacheRead: number };
  /** Active on the files store (odd/tasks/memory-active-files.md): turns that wrote, and what they and the session-start replays wrote. */
  readonly activeDecisions: number;
  readonly written: number;
  readonly updated: number;
  readonly backups: number;
  readonly spooled: number;
  readonly replayed: number;
  readonly writeFailures: number;
  readonly dropped: number;
  readonly lockHeld: number;
}

function memoryCost(tally: TranscriptTally, rows: readonly unknown[], window: TimeWindow): MemoryCost {
  let engramCallTotal = 0;
  for (const calls of tally.engramCalls.values()) engramCallTotal += calls;
  let responsesWithEngram = 0;
  let engramOnlyResponses = 0;
  let engramOnlySaveResponses = 0;
  let engramOnlyJudgeOnlyResponses = 0;
  for (const response of tally.engramResponses.values()) {
    if (response.engram.size === 0) continue;
    responsesWithEngram += 1;
    if (response.other > 0) continue;
    engramOnlyResponses += 1;
    if (response.engram.has("mem_save")) engramOnlySaveResponses += 1;
    else if (response.engram.has("mem_judge")) engramOnlyJudgeOnlyResponses += 1;
  }
  // The rows are already the window's: the whole span is the summary's window.
  const log = summarizeMemoryDecisions(rows, window.untilMs, window.untilMs - window.sinceMs);
  return {
    engramCalls: Object.fromEntries(tally.engramCalls),
    engramCallTotal,
    engramCallsPerPrompt: ratio(engramCallTotal, tally.prompts),
    responsesWithEngram,
    engramOnlyResponses,
    engramOnlySaveResponses,
    engramOnlyJudgeOnlyResponses,
    gates: log.gates,
    gateFailures: log.gateFailures,
    updates: log.updates,
    gatesPerPrompt: ratio(log.gates, tally.prompts),
    forks: log.forks,
    forksPerPrompt: ratio(log.forks, tally.prompts),
    judgeBuilds: log.judgeBuilds,
    judgeBuildsPerPrompt: ratio(log.judgeBuilds, tally.prompts),
    haikuTokens: log.haikuTokens,
    forkTokens: log.forkTokens,
    activeDecisions: log.activeDecisions,
    written: log.written,
    updated: log.updated,
    backups: log.backups,
    spooled: log.spooled,
    replayed: log.replayed,
    writeFailures: log.writeFailures,
    dropped: log.dropped,
    lockHeld: log.lockHeld,
  };
}

function rowAt(row: unknown): number {
  return isRecord(row) && typeof row["at"] === "string" ? Date.parse(row["at"]) : Number.NaN;
}

function inWindowRows(rows: readonly unknown[], window: TimeWindow): unknown[] {
  return rows.filter((row) => inWindow(window, rowAt(row)));
}

function sumCalls(parts: ReadonlyArray<{ readonly rows: readonly unknown[]; readonly count: (row: unknown) => JevCallCount }>): { calls: number; failures: number; latencyMs: number[] } {
  let calls = 0;
  let failures = 0;
  const latencyMs: number[] = [];
  for (const part of parts) {
    for (const row of part.rows) {
      const counted = part.count(row);
      calls += counted.calls;
      failures += counted.failures;
      latencyMs.push(...counted.latencyMs);
    }
  }
  return { calls, failures, latencyMs };
}

function ratio(value: number, over: number): number | null {
  return over > 0 ? value / over : null;
}

function modesOf(rows: readonly unknown[], filter: (row: Record<string, unknown>) => boolean): Record<string, number> {
  const modes: Record<string, number> = {};
  for (const row of rows) {
    if (!isRecord(row) || !filter(row)) continue;
    const mode = typeof row["mode"] === "string" ? row["mode"] : "unknown";
    modes[mode] = (modes[mode] ?? 0) + 1;
  }
  return modes;
}

function toolCallsMatching(hooks: readonly InstalledHook[], module: ModuleId, toolCalls: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const [tool, calls] of toolCalls) {
    if (hooks.some((hook) => hook.module === module && hook.event === "PreToolUse" && matches(hook.matcher, tool))) total += calls;
  }
  return total;
}

export function buildModuleCostReport(input: ModuleCostInput): ModuleCostReport {
  const { window, tally, hooks } = input;
  const rows = {
    gate: inWindowRows(input.rows.gate, window),
    skills: inWindowRows(input.rows.skills, window),
    tools: inWindowRows(input.rows.tools, window),
    router: inWindowRows(input.rows.router, window),
    models: inWindowRows(input.rows.models, window),
    steward: inWindowRows(input.rows.steward, window),
    verifyDone: inWindowRows(input.rows.verifyDone, window),
    ciWatch: inWindowRows(input.rows.ciWatch, window),
    memory: inWindowRows(input.rows.memory, window),
  };
  const spawns = derivedHookSpawns(hooks, tally.toolCalls, tally.toolErrors);
  const jev: Record<ModuleId, { calls: number; failures: number; latencyMs: number[] }> = {
    gate: sumCalls([{ rows: rows.gate, count: gateJevCalls }]),
    "model-router": sumCalls([{ rows: rows.router, count: routerJevCalls }, { rows: rows.models, count: modelDecisionJevCalls }]),
    steward: sumCalls([{ rows: rows.steward, count: stewardJevCalls }]),
    "skill-selection": sumCalls([{ rows: rows.skills, count: skillJevCalls }, { rows: rows.tools, count: toolJevCalls }]),
    board: { calls: 0, failures: 0, latencyMs: [] },
    "verify-done": sumCalls([{ rows: rows.verifyDone, count: verifyDoneJevCalls }]),
    // It makes no Jev call: its cost is gh processes, counted in the watch rows.
    "ci-watch": { calls: 0, failures: 0, latencyMs: [] },
  };
  const modules = MODULE_IDS.map((module): ModuleCostRow => {
    const hookMs = module === "gate" ? tally.gateBashHookMs : [];
    const calls = jev[module];
    return {
      module,
      hookSpawns: spawns[module],
      hookSpawnsPerToolCall: ratio(spawns[module], toolCallsMatching(hooks, module, tally.toolCalls)),
      hookMsP50: percentile(hookMs, 50),
      hookMsP90: percentile(hookMs, 90),
      hookTimed: hookMs.length,
      jevCalls: calls.calls,
      jevFailures: calls.failures + (module === "gate" ? tally.gateHookCancelled : 0),
      jevPerPrompt: ratio(calls.calls, tally.prompts),
      jevPerTurn: ratio(calls.calls, tally.turns),
      jevMsP50: percentile(calls.latencyMs, 50),
      jevMsP90: percentile(calls.latencyMs, 90),
      jevTimed: calls.latencyMs.length,
    };
  });

  const { firstMs, lastMs } = input.audit;
  const spanHours = firstMs !== null && lastMs !== null && lastMs > firstMs ? (lastMs - firstMs) / 3_600_000 : null;
  const boardTimes = input.audit.times.get("board") ?? [];
  const worker = WORKER_TASKS.map((task): WorkerRow => {
    const observed = task.auditKey === null || spanHours === null ? null : (input.audit.times.get(task.auditKey)?.length ?? 0) / spanHours;
    const derived = task.intervalMs === null ? null : 3_600_000 / task.intervalMs;
    const runs = observed ?? derived;
    return {
      id: task.id,
      trigger: task.trigger,
      owner: task.owner,
      modules: task.modules,
      auditKey: task.auditKey,
      derivedPerHour: derived,
      observedPerHour: observed,
      sidecarsPerHour: runs === null ? null : runs * task.sidecarsPerRun,
      otherSpawns: task.otherSpawns,
    };
  });

  let toolCalls = 0;
  for (const calls of tally.toolCalls.values()) toolCalls += calls;
  return {
    window,
    prompts: tally.prompts,
    turns: tally.turns,
    toolCalls,
    modules,
    modes: {
      skills: modesOf(rows.skills, (row) => row["type"] === "decision"),
      tools: modesOf(rows.tools, (row) => row["type"] === "decision"),
      steward: modesOf(rows.steward, () => true),
    },
    agentSpawns: {
      agentCalls: tally.toolCalls.get("Agent") ?? 0,
      reclassifications: rows.models.filter((row) => isRecord(row) && row["type"] === "model-decision").length,
      routerSubagentRows: rows.router.filter((row) => isRecord(row) && row["point"] === "subagent").length,
    },
    audit: { firstMs, lastMs, spanHours, boardCliRefreshesPerHour: spanHours === null ? null : boardCliRefreshes(boardTimes, 30_000) / spanHours },
    worker,
    verifyDone: {
      // The rows are already the window's: the whole span is the summary's window.
      ...summarizeVerifyDoneDecisions(rows.verifyDone, window.untilMs, window.untilMs - window.sinceMs),
      candidateTurns: tally.verifyDoneCandidates,
      personTurns: tally.verifyDoneTurns,
      candidatesPerPrompt: ratio(tally.verifyDoneCandidates, tally.prompts),
    },
    ciWatch: {
      // The rows are already the window's: the whole span is the summary's window.
      ...summarizeCiWatchRows(rows.ciWatch, window.untilMs, window.untilMs - window.sinceMs),
      mainThreadPolls: tally.ciPolls,
      mainThreadLongSleeps: tally.ciSleeps,
      mainThreadSleeps: tally.anySleeps,
    },
    memory: memoryCost(tally, rows.memory, window),
  };
}

function fixed(value: number | null, digits = 2): string {
  return value === null ? "-" : Number(value.toFixed(digits)).toString();
}

function ms(p50: number | null, p90: number | null, n: number): string {
  return p50 === null ? "not logged" : `${fixed(p50, 0)} / ${fixed(p90, 0)} (n=${n})`;
}

function iso(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString().slice(0, 16) + "Z";
}

/** The report as markdown lines: one table per cost, then the worker table. */
export function formatModuleCostReport(report: ModuleCostReport): string[] {
  const lines: string[] = [];
  lines.push(`Window: ${iso(report.window.sinceMs)} to ${iso(report.window.untilMs)}. Person prompts ${report.prompts}, completed turns ${report.turns}, tool calls ${report.toolCalls}.`);
  lines.push("");
  lines.push("| Module | Hook spawns (derived) | per matching tool call | Hook ms p50 / p90 (observed) | Jev calls | per prompt | per turn | Jev ms p50 / p90 | Jev failures |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const row of report.modules) {
    lines.push(`| ${row.module} | ${row.hookSpawns} | ${fixed(row.hookSpawnsPerToolCall)} | ${row.hookSpawns === 0 ? "-" : ms(row.hookMsP50, row.hookMsP90, row.hookTimed)} | ${row.jevCalls} | ${fixed(row.jevPerPrompt)} | ${fixed(row.jevPerTurn)} | ${row.jevCalls === 0 ? "-" : ms(row.jevMsP50, row.jevMsP90, row.jevTimed)} | ${row.jevFailures} |`);
  }
  lines.push("");
  const modes = (value: Record<string, number>): string => Object.entries(value).map(([mode, count]) => `${mode} ${count}`).join(", ") || "none";
  lines.push(`Mod modes in the window: skills ${modes(report.modes.skills)}; tools ${modes(report.modes.tools)}; steward ${modes(report.modes.steward)}.`);
  const done = report.verifyDone;
  const ci = report.ciWatch;
  lines.push(`ci-watch: ${ci.watches} watches (${ci.finished} ended with a verdict, ${ci.failed} failed), ${ci.ghCalls} gh calls; during them the agent made ${ci.pollsReplaced} CI polls and ${ci.sleepsReplaced} sleeps of 10 s or more that a note would replace, ${ci.injected} notes sent. Main thread in the window: ${ci.mainThreadPolls} CI polls, ${ci.mainThreadLongSleeps} sleeps of 10 s or more, ${ci.mainThreadSleeps} sleeps of any length.`);
  lines.push(`verify-done: ${done.wouldBlock} would-block turns (claimed done, unverified) of ${done.decisions} logged; ${done.claims} claims of done, ${done.jevFailed} Jev failures. Transcripts: ${done.candidateTurns} of ${done.personTurns} person turns are candidates (${fixed(done.candidatesPerPrompt)} per prompt).`);
  const memory = report.memory;
  lines.push(`memory (main thread, transcripts): ${memory.engramCallTotal} Engram calls (${fixed(memory.engramCallsPerPrompt)} per prompt); ${memory.responsesWithEngram} responses held an Engram call, ${memory.engramOnlyResponses} held only Engram calls (${memory.engramOnlySaveResponses} with a save, ${memory.engramOnlyJudgeOnlyResponses} with judges and no save).`);
  const byTool = Object.entries(memory.engramCalls).sort((a, b) => b[1] - a[1]).map(([tool, calls]) => `${tool} ${calls}`).join(", ");
  if (byTool !== "") lines.push(`memory Engram calls by tool: ${byTool}.`);
  lines.push(`memory (module, its log): ${memory.gates} Haiku gates (${fixed(memory.gatesPerPrompt)} per prompt, ${memory.gateFailures} failed, ${memory.updates} UPDATE), ${memory.forks} forks (${fixed(memory.forksPerPrompt)} per prompt), ${memory.judgeBuilds} judge builds (${fixed(memory.judgeBuildsPerPrompt)} per prompt, none asked); Haiku tokens ${memory.haikuTokens.input} in / ${memory.haikuTokens.output} out; fork tokens ${memory.forkTokens.input} in / ${memory.forkTokens.output} out / ${memory.forkTokens.cacheRead} cache read.`);
  lines.push(`memory (Active, its log): ${memory.activeDecisions} turns wrote the files store; ${memory.written} files written, ${memory.updated} rewritten (${memory.backups} backups), ${memory.spooled} saves spooled, ${memory.replayed} replayed at a session start, ${memory.writeFailures} failed writes, ${memory.dropped} refused updates, ${memory.lockHeld} passes held by the lock.`);
  lines.push(`Agent spawns: ${report.agentSpawns.agentCalls} Agent calls; ${report.agentSpawns.reclassifications} agent-model decisions; ${report.agentSpawns.routerSubagentRows} router subagent rows.`);
  lines.push("");
  lines.push(`Worker (audit log ${iso(report.audit.firstMs)} to ${iso(report.audit.lastMs)}, ${fixed(report.audit.spanHours, 1)} h; board CLI cache refreshes ${fixed(report.audit.boardCliRefreshesPerHour, 1)}/h):`);
  lines.push("");
  lines.push("| Task | Trigger | Owner | Runs/h derived | Runs/h observed | Node sidecars/h | Other spawns |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of report.worker) {
    const owner = row.owner === "shared" ? `shared (${row.modules.join(", ")})` : row.owner;
    lines.push(`| ${row.id} | ${row.trigger} | ${owner} | ${fixed(row.derivedPerHour, 1)} | ${row.auditKey === null ? "no audit key" : fixed(row.observedPerHour, 1)} | ${fixed(row.sidecarsPerHour, 1)} | ${row.otherSpawns || "-"} |`);
  }
  return lines;
}
