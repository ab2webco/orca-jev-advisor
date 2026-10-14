// ---------------------------------------------------------------------------
// Memory module, detection (odd/tasks/memory-core.md, M1).
//
// Which memory backend a session has, and which signal decided it:
//   live             Engram's tools are connected in this session. It is the
//                    store of record; auto-memory mirrors only feedback and user.
//   configured-down  Engram is configured (user-scope server, enabled plugin or
//                    the binary) but its tools are not connected, or the health
//                    call failed. Saves fall back to auto-memory and replay later.
//   absent           No sign of Engram. Auto-memory is the one store.
//
// The server name to call comes from the tool names `$.tool.list()` returns
// (`ToolInfo` has no server field): `mcp__engram__mem_save` is `engram`,
// `mcp__plugin_engram_engram__mem_save` is `plugin_engram_engram`
// (odd/research/engine-probes-2.1.296.md, b). A `$.mcp.call` with no permission
// rule is refused in a headless session; that is `permission`, never "down".
//
// Pure: no I/O and no node: import, so the mod sandbox can load it too. The
// hooks module lists the tools, reads the files and runs the health call.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";

export type MemoryBackend = "live" | "configured-down" | "absent";

/** What the health call (`mem_current_project`) came to. */
export type HealthOutcome = "ok" | "permission" | "failed";

export interface MemorySignals {
  /** The Engram server name taken from the tool names, null when none is listed. */
  readonly liveServer: string | null;
  /** The health call's outcome, null when it was not run. */
  readonly health: HealthOutcome | null;
  /** `mcpServers` of the user-scope `.claude.json` has an Engram server. */
  readonly userConfigured: boolean;
  /** `enabledPlugins["engram@engram"]` is true. */
  readonly pluginEnabled: boolean;
  /** `engram version`'s version, null when the binary did not answer. */
  readonly binaryVersion: string | null;
}

export type MemorySignalName = "tools+health" | "tools" | "health" | "user-config" | "plugin" | "binary" | "none";

export interface MemoryBackendDecision {
  readonly backend: MemoryBackend;
  /** The signal that decided, for the panel. */
  readonly decidedBy: MemorySignalName;
  /** The MCP server name to call, null when Engram cannot be called. */
  readonly server: string | null;
  /** `refused` when the health call was refused for want of a permission rule. */
  readonly permission: "ok" | "refused" | "unknown";
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const ENGRAM_SAVE_TOOL = /^mcp__(engram|plugin_engram_engram)__mem_save$/;

/** The Engram server named by the session's tools, or null. The manual `engram` server wins when both spellings are listed. */
export function engramServerFromTools(tools: readonly { readonly name: string }[]): string | null {
  const servers = new Set<string>();
  for (const tool of tools) {
    const match = ENGRAM_SAVE_TOOL.exec(tool.name);
    if (match !== null && match[1] !== undefined) servers.add(match[1]);
  }
  if (servers.has("engram")) return "engram";
  return servers.has("plugin_engram_engram") ? "plugin_engram_engram" : null;
}

/** Whether `server` lists `tool`: older Engram (1.12.0) has `mem_save` but no `mem_current_project` or `mem_judge`, so a call is made only to a tool that is there. */
export function engramHasTool(tools: readonly { readonly name: string }[], server: string, tool: string): boolean {
  const name = `mcp__${server}__${tool}`;
  return tools.some((listed) => listed.name === name);
}

function parseRecord(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function programName(command: unknown): string {
  if (typeof command !== "string") return "";
  const last = command.split("/").pop();
  return last === undefined ? "" : last;
}

/** Whether the user-scope `.claude.json` content configures an Engram MCP server: one named `engram`, or any that runs the `engram` binary. */
export function parseUserMcpEngram(content: string): boolean {
  const config = parseRecord(content);
  if (config === null || !isRecord(config.mcpServers)) return false;
  return Object.entries(config.mcpServers).some(([name, server]) => isRecord(server) && (name === "engram" || programName(server.command) === "engram"));
}

/** Whether the settings.json content enables the Engram Claude plugin (`engram@engram` is the boolean true). */
export function parseEnabledEngramPlugin(content: string): boolean {
  const settings = parseRecord(content);
  return settings !== null && isRecord(settings.enabledPlugins) && settings.enabledPlugins["engram@engram"] === true;
}

/** The version in `engram version`'s output (`engram 2.1.0`), or null for anything else. */
export function parseEngramVersion(output: string): string | null {
  const match = /^engram\s+v?(\d+\.\d+\.\d+[\w.+-]*)/m.exec(output.trim());
  return match !== null && match[1] !== undefined ? match[1] : null;
}

/** The health call as the hooks module saw it: an MCP result, or the text of the error it threw. */
export type HealthCall = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string };

const PERMISSION_REFUSAL = /requested permissions? to use|haven'?t granted|permission (rule|denied)|\brefused:/i;

/** Whether an error text is the engine refusing an `$.mcp.call` for want of a permission rule (not Engram being down). */
export function isPermissionRefusal(error: string): boolean {
  return PERMISSION_REFUSAL.test(error);
}

/** A refusal for want of a permission rule is `permission`; any other error, and an MCP `isError` result, is `failed`. */
export function classifyHealthOutcome(call: HealthCall): HealthOutcome {
  if (call.ok) return isRecord(call.result) && call.result.isError === true ? "failed" : "ok";
  return isPermissionRefusal(call.error) ? "permission" : "failed";
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Computed at `session.start` and again after a failure. */
export function detectMemoryBackend(signals: MemorySignals): MemoryBackendDecision {
  if (signals.liveServer !== null) {
    if (signals.health === "failed") return { backend: "configured-down", decidedBy: "health", server: null, permission: "unknown" };
    if (signals.health === "permission") return { backend: "live", decidedBy: "tools+health", server: signals.liveServer, permission: "refused" };
    if (signals.health === "ok") return { backend: "live", decidedBy: "tools+health", server: signals.liveServer, permission: "ok" };
    return { backend: "live", decidedBy: "tools", server: signals.liveServer, permission: "unknown" };
  }
  const down = (decidedBy: MemorySignalName): MemoryBackendDecision => ({ backend: "configured-down", decidedBy, server: null, permission: "unknown" });
  if (signals.userConfigured) return down("user-config");
  if (signals.pluginEnabled) return down("plugin");
  if (signals.binaryVersion !== null) return down("binary");
  return { backend: "absent", decidedBy: "none", server: null, permission: "unknown" };
}

/** Whether a save can go to Engram right now: live, with a server to call and no permission refusal. */
export function engramUsable(decision: MemoryBackendDecision): boolean {
  return decision.backend === "live" && decision.server !== null && decision.permission !== "refused";
}

// ---------------------------------------------------------------------------
// The auto-memory folder
// ---------------------------------------------------------------------------

/** The engine's folder name for a path: every non-alphanumeric character becomes a dash. */
export function projectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

function withoutTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

/** `CLAUDE_CONFIG_DIR` (an Orca account folder) when set, else `~/.claude`. */
export function claudeConfigDir(input: { readonly claudeConfigDir: string | null; readonly home: string }): string {
  if (input.claudeConfigDir !== null && input.claudeConfigDir !== "") return withoutTrailingSlashes(input.claudeConfigDir);
  return `${withoutTrailingSlashes(input.home)}/.claude`;
}

export interface AutoMemoryDirInput {
  readonly configDir: string;
  /** `$.session.repo()?.root`: the main checkout, shared by every worktree of the repository. */
  readonly repoRoot: string | null;
  /** `$.session.cwd()`, the fallback when there is no repository. */
  readonly cwd: string;
  /** The `autoMemoryDirectory` setting, when the person set one. */
  readonly setting?: string | null;
  readonly home?: string;
}

/**
 * Where Claude Code reads and writes auto-memory:
 * `<config>/projects/<slug of the repo root>/memory`. The root, not the
 * worktree cwd: every worktree of a repository shares the main checkout's
 * memory (odd/research/engine-probes-2.1.296.md, d). An `autoMemoryDirectory`
 * setting wins. (The engine shortens a slug of over 200 characters with a
 * hash; that case is not modelled.)
 */
export function autoMemoryDir(input: AutoMemoryDirInput): string {
  if (input.setting !== undefined && input.setting !== null && input.setting !== "") {
    const expanded = input.setting.startsWith("~/") && input.home !== undefined ? `${withoutTrailingSlashes(input.home)}${input.setting.slice(1)}` : input.setting;
    return withoutTrailingSlashes(expanded);
  }
  const root = input.repoRoot !== null && input.repoRoot !== "" ? input.repoRoot : input.cwd;
  return `${withoutTrailingSlashes(input.configDir)}/projects/${projectSlug(root)}/memory`;
}
