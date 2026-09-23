// Typed, validated wrappers around the `orca` CLI. Every call shells out to
// the real binary via node:child_process, parses its --json output, checks
// the standard {id, ok, result|error} envelope, and either returns a typed
// result or throws a descriptive Error. Nothing here prints anything: this
// module returns values, the CLI entry (supervisor.ts) decides what to show.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isArrayOf, isBoolean, isNumber, isNumberOrNull, isRecord, isString, isStringOrNull } from "./guards.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Generic envelope + runOrca
// ---------------------------------------------------------------------------

interface OrcaOkEnvelope {
  id: string;
  ok: true;
  result: unknown;
}

interface OrcaErrorEnvelope {
  id: string;
  ok: false;
  error: { code?: string; message?: string };
}

type OrcaEnvelope = OrcaOkEnvelope | OrcaErrorEnvelope;

function isErrorShape(value: unknown): value is { code?: string; message?: string } {
  if (!isRecord(value)) return false;
  if ("code" in value && value.code !== undefined && !isString(value.code)) return false;
  if ("message" in value && value.message !== undefined && !isString(value.message)) return false;
  return true;
}

function isOrcaEnvelope(value: unknown): value is OrcaEnvelope {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isBoolean(value.ok)) return false;
  if (value.ok === true) {
    return "result" in value;
  }
  return isErrorShape(value.error);
}

/**
 * Runs `orca <args> --json`, parses stdout as JSON, validates the standard
 * envelope, and returns the raw `result` on success. Throws a descriptive
 * Error on any failure: the process failing to spawn, non-JSON stdout, a
 * malformed envelope, or an explicit ok:false response.
 */
export async function runOrca(args: string[], execTimeoutMs = 60_000): Promise<unknown> {
  const fullArgs = [...args, "--json"];
  const commandLabel = `orca ${fullArgs.join(" ")}`;

  let stdout: string;
  try {
    const execResult = await execFileAsync("orca", fullArgs, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: execTimeoutMs,
    });
    stdout = execResult.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${commandLabel} failed to execute: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${commandLabel} did not return valid JSON: ${message}`);
  }

  if (!isOrcaEnvelope(parsed)) {
    throw new Error(`${commandLabel} returned a response with an unexpected shape (expected {id, ok, result|error})`);
  }

  if (!parsed.ok) {
    const code = parsed.error.code !== undefined ? parsed.error.code : "unknown";
    const message = parsed.error.message !== undefined ? parsed.error.message : "no message";
    throw new Error(`${commandLabel} responded with error [${code}]: ${message}`);
  }

  return parsed.result;
}

// ---------------------------------------------------------------------------
// orca worktree ps --json
// ---------------------------------------------------------------------------

export type AgentState = "done" | "working" | "blocked" | "waiting";

function isAgentState(value: unknown): value is AgentState {
  return value === "done" || value === "working" || value === "blocked" || value === "waiting";
}

export interface WorktreeAgent {
  paneKey: string;
  state: AgentState;
  agentType: string;
  prompt: string | null;
  lastAssistantMessage: string | null;
  updatedAt: number | null;
}

function isWorktreeAgent(value: unknown): value is WorktreeAgent {
  if (!isRecord(value)) return false;
  return (
    isString(value.paneKey) &&
    isAgentState(value.state) &&
    isString(value.agentType) &&
    isStringOrNull(value.prompt) &&
    isStringOrNull(value.lastAssistantMessage) &&
    isNumberOrNull(value.updatedAt)
  );
}

export interface Worktree {
  worktreeId: string;
  repo: string;
  path: string;
  branch: string;
  displayName: string;
  liveTerminalCount: number;
  lastOutputAt: number | null;
  agents: WorktreeAgent[];
}

function isWorktree(value: unknown): value is Worktree {
  if (!isRecord(value)) return false;
  return (
    isString(value.worktreeId) &&
    isString(value.repo) &&
    isString(value.path) &&
    isString(value.branch) &&
    isString(value.displayName) &&
    isNumber(value.liveTerminalCount) &&
    isNumberOrNull(value.lastOutputAt) &&
    isArrayOf(value.agents, isWorktreeAgent)
  );
}

export interface WorktreePsResult {
  worktrees: Worktree[];
}

function isWorktreePsResult(value: unknown): value is WorktreePsResult {
  return isRecord(value) && isArrayOf(value.worktrees, isWorktree);
}

export async function worktreePs(): Promise<WorktreePsResult> {
  const result = await runOrca(["worktree", "ps"]);
  if (!isWorktreePsResult(result)) {
    throw new Error("orca worktree ps --json: the 'result' field does not have the expected shape {worktrees: [...]}");
  }
  return result;
}

// ---------------------------------------------------------------------------
// orca terminal list --json
// ---------------------------------------------------------------------------

export interface Terminal {
  handle: string;
  worktreeId: string;
  worktreePath: string;
  branch: string;
  title: string | null;
  connected: boolean;
  writable: boolean;
  liveness: string;
  lastOutputAt: number | null;
  preview: string;
}

function isTerminal(value: unknown): value is Terminal {
  if (!isRecord(value)) return false;
  return (
    isString(value.handle) &&
    isString(value.worktreeId) &&
    isString(value.worktreePath) &&
    isString(value.branch) &&
    isStringOrNull(value.title) &&
    isBoolean(value.connected) &&
    isBoolean(value.writable) &&
    isString(value.liveness) &&
    isNumberOrNull(value.lastOutputAt) &&
    isString(value.preview)
  );
}

export interface TerminalListResult {
  terminals: Terminal[];
}

function isTerminalListResult(value: unknown): value is TerminalListResult {
  return isRecord(value) && isArrayOf(value.terminals, isTerminal);
}

export async function terminalList(): Promise<TerminalListResult> {
  const result = await runOrca(["terminal", "list"]);
  if (!isTerminalListResult(result)) {
    throw new Error("orca terminal list --json: the 'result' field does not have the expected shape {terminals: [...]}");
  }
  return result;
}

// ---------------------------------------------------------------------------
// orca terminal wait --json
// ---------------------------------------------------------------------------

export type WaitCondition = "writable" | "composer-ready" | "tui-idle" | "exit";

function isWaitCondition(value: unknown): value is WaitCondition {
  return value === "writable" || value === "composer-ready" || value === "tui-idle" || value === "exit";
}

export interface TerminalWait {
  handle: string;
  condition: WaitCondition;
  satisfied: boolean;
  status: string;
  exitCode: number | null;
}

function isTerminalWait(value: unknown): value is TerminalWait {
  if (!isRecord(value)) return false;
  return (
    isString(value.handle) &&
    isWaitCondition(value.condition) &&
    isBoolean(value.satisfied) &&
    isString(value.status) &&
    isNumberOrNull(value.exitCode)
  );
}

export interface TerminalWaitResult {
  wait: TerminalWait;
}

function isTerminalWaitResult(value: unknown): value is TerminalWaitResult {
  return isRecord(value) && isTerminalWait(value.wait);
}

export async function terminalWait(handle: string, condition: WaitCondition, timeoutMs: number): Promise<TerminalWaitResult> {
  const result = await runOrca(
    ["terminal", "wait", "--terminal", handle, "--for", condition, "--timeout-ms", String(timeoutMs)],
    timeoutMs + 10_000,
  );
  if (!isTerminalWaitResult(result)) {
    throw new Error("orca terminal wait --json: the 'result' field does not have the expected shape {wait: {...}}");
  }
  return result;
}

// ---------------------------------------------------------------------------
// orca terminal send --json
// ---------------------------------------------------------------------------

export interface TerminalSend {
  handle: string;
  accepted: boolean;
  bytesWritten: number;
}

function isTerminalSend(value: unknown): value is TerminalSend {
  if (!isRecord(value)) return false;
  return isString(value.handle) && isBoolean(value.accepted) && isNumber(value.bytesWritten);
}

export interface TerminalSendResult {
  send: TerminalSend;
}

function isTerminalSendResult(value: unknown): value is TerminalSendResult {
  return isRecord(value) && isTerminalSend(value.send);
}

export async function terminalSend(handle: string, text: string): Promise<TerminalSendResult> {
  const result = await runOrca(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]);
  if (!isTerminalSendResult(result)) {
    throw new Error("orca terminal send --json: the 'result' field does not have the expected shape {send: {...}}");
  }
  return result;
}

// ---------------------------------------------------------------------------
// orca terminal read --json
// ---------------------------------------------------------------------------

export interface TerminalReadInfo {
  handle: string;
  status: string;
  tail: string[];
  nextCursor: string | null;
}

function isTerminalReadInfo(value: unknown): value is TerminalReadInfo {
  if (!isRecord(value)) return false;
  return isString(value.handle) && isString(value.status) && isArrayOf(value.tail, isString) && isStringOrNull(value.nextCursor);
}

export interface TerminalReadResult {
  terminal: TerminalReadInfo;
}

function isTerminalReadResult(value: unknown): value is TerminalReadResult {
  return isRecord(value) && isTerminalReadInfo(value.terminal);
}

export async function terminalRead(handle: string, limit: number): Promise<TerminalReadResult> {
  const result = await runOrca(["terminal", "read", "--terminal", handle, "--limit", String(limit)]);
  if (!isTerminalReadResult(result)) {
    throw new Error("orca terminal read --json: the 'result' field does not have the expected shape {terminal: {...}}");
  }
  return result;
}
