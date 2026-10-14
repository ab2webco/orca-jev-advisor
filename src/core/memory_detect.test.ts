// The memory module (odd/tasks/memory-core.md, M1): which memory backend a
// session has. Pure: the hooks module lists the tools, reads the config files
// and runs the health call; these rules only decide.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  autoMemoryDir,
  claudeConfigDir,
  classifyHealthOutcome,
  detectMemoryBackend,
  engramHasTool,
  engramServerFromTools,
  engramUsable,
  isPermissionRefusal,
  parseEngramVersion,
  parseEnabledEngramPlugin,
  parseUserMcpEngram,
  projectSlug,
} from "./memory_detect.ts";
import type { MemorySignals } from "./memory_detect.ts";

const NONE: MemorySignals = { liveServer: null, health: null, userConfigured: false, pluginEnabled: false, binaryVersion: null };

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_detect.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// Live tools: the server name comes from the tool names
// ---------------------------------------------------------------------------

test("tools: the user-scope server is named engram", () => {
  const tools = [{ name: "Read" }, { name: "mcp__engram__mem_search" }, { name: "mcp__engram__mem_save" }];
  assert.equal(engramServerFromTools(tools), "engram");
});

test("tools: the plugin-provided server is named plugin_engram_engram", () => {
  assert.equal(engramServerFromTools([{ name: "mcp__plugin_engram_engram__mem_save" }]), "plugin_engram_engram");
});

test("tools: when both spellings are listed, the manual server wins (the engine drops the plugin copy)", () => {
  const tools = [{ name: "mcp__plugin_engram_engram__mem_save" }, { name: "mcp__engram__mem_save" }];
  assert.equal(engramServerFromTools(tools), "engram");
});

test("tools: no mem_save, no server (search alone is not enough to write)", () => {
  assert.equal(engramServerFromTools([{ name: "mcp__engram__mem_search" }, { name: "Bash" }]), null);
});

// Engram 1.12.0 (a partner's Linux, 2026-10-13) lists mem_save but has no
// mem_current_project: calling it always failed, so a working Engram read as
// configured-down on every row.
const OLD_ENGRAM_TOOLS = ["mem_capture_passive", "mem_context", "mem_get_observation", "mem_save", "mem_save_prompt", "mem_search", "mem_session_end", "mem_session_start", "mem_session_summary", "mem_suggest_topic_key", "mem_update"].map((tool) => ({ name: `mcp__plugin_engram_engram__${tool}` }));

test("health tool: an Engram that lists mem_current_project can be health-checked", () => {
  const tools = [{ name: "mcp__engram__mem_save" }, { name: "mcp__engram__mem_current_project" }];
  assert.equal(engramHasTool(tools, "engram", "mem_current_project"), true);
});

test("health tool: Engram 1.12.0 has no mem_current_project, so no health call is made", () => {
  assert.equal(engramServerFromTools(OLD_ENGRAM_TOOLS), "plugin_engram_engram");
  assert.equal(engramHasTool(OLD_ENGRAM_TOOLS, "plugin_engram_engram", "mem_current_project"), false);
  assert.equal(engramHasTool(OLD_ENGRAM_TOOLS, "plugin_engram_engram", "mem_judge"), false);
});

test("health tool: another server's tool does not count", () => {
  const tools = [{ name: "mcp__engram__mem_save" }, { name: "mcp__plugin_engram_engram__mem_current_project" }];
  assert.equal(engramHasTool(tools, "engram", "mem_current_project"), false);
});

test("health tool: with no health call the decision is live by tools alone", () => {
  assert.deepEqual(detectMemoryBackend({ ...NONE, liveServer: "plugin_engram_engram" }), { backend: "live", decidedBy: "tools", server: "plugin_engram_engram", permission: "unknown" });
});

test("tools: another server's mem_save is not Engram", () => {
  assert.equal(engramServerFromTools([{ name: "mcp__other__mem_save" }, { name: "mcp__engram_fake__mem_save" }]), null);
  assert.equal(engramServerFromTools([]), null);
});

// ---------------------------------------------------------------------------
// Configuration signals
// ---------------------------------------------------------------------------

test("user config: mcpServers.engram is a configured server", () => {
  const json = JSON.stringify({ mcpServers: { engram: { command: "/opt/homebrew/bin/engram", args: ["mcp", "--tools=agent"] } } });
  assert.equal(parseUserMcpEngram(json), true);
});

test("user config: a server under another name that runs the engram binary counts", () => {
  const json = JSON.stringify({ mcpServers: { memory: { command: "/usr/local/bin/engram", args: ["mcp"] } } });
  assert.equal(parseUserMcpEngram(json), true);
});

test("user config: no engram server, wrong shape, malformed or empty content are false, never a throw", () => {
  assert.equal(parseUserMcpEngram(JSON.stringify({ mcpServers: { graft: { command: "graft" } } })), false);
  assert.equal(parseUserMcpEngram(JSON.stringify({ mcpServers: [] })), false);
  assert.equal(parseUserMcpEngram(JSON.stringify({ mcpServers: { engram: null } })), false);
  assert.equal(parseUserMcpEngram("{ not json"), false);
  assert.equal(parseUserMcpEngram(""), false);
});

test("plugin: enabledPlugins engram@engram true is enabled, false or absent is not", () => {
  assert.equal(parseEnabledEngramPlugin(JSON.stringify({ enabledPlugins: { "engram@engram": true } })), true);
  assert.equal(parseEnabledEngramPlugin(JSON.stringify({ enabledPlugins: { "engram@engram": false } })), false);
  assert.equal(parseEnabledEngramPlugin(JSON.stringify({ enabledPlugins: { "engram@engram": "true" } })), false);
  assert.equal(parseEnabledEngramPlugin(JSON.stringify({ enabledPlugins: { "other@x": true } })), false);
  assert.equal(parseEnabledEngramPlugin("[]"), false);
  assert.equal(parseEnabledEngramPlugin("nope"), false);
});

test("binary: `engram version` output gives the version, anything else gives null", () => {
  assert.equal(parseEngramVersion("engram 2.1.0\n"), "2.1.0");
  assert.equal(parseEngramVersion("engram v2.1.0-rc1"), "2.1.0-rc1");
  assert.equal(parseEngramVersion("command not found: engram"), null);
  assert.equal(parseEngramVersion(""), null);
});

// ---------------------------------------------------------------------------
// The health call
// ---------------------------------------------------------------------------

test("health: an answered call is ok, an MCP isError result is a failure", () => {
  assert.equal(classifyHealthOutcome({ ok: true, result: { content: [{ type: "text", text: "{}" }], isError: false } }), "ok");
  assert.equal(classifyHealthOutcome({ ok: true, result: { content: [], isError: true } }), "failed");
});

test("health: the headless permission refusal is permission, never failed", () => {
  const refused = "m0-probe: $.mcp.call(engram, mem_current_project) refused: Claude requested permissions to use mcp__engram__mem_current_project, but you haven't granted it yet.";
  assert.equal(classifyHealthOutcome({ ok: false, error: refused }), "permission");
});

test("health: a missing tool, a timeout and a refused connection are failed", () => {
  assert.equal(classifyHealthOutcome({ ok: false, error: '$.mcp.call: no connected MCP tool "mem_current_project" on a server named "engram"' }), "failed");
  assert.equal(classifyHealthOutcome({ ok: false, error: "timed out after 5000 ms" }), "failed");
  assert.equal(classifyHealthOutcome({ ok: false, error: "connect ECONNREFUSED 127.0.0.1:7437" }), "failed");
  assert.equal(classifyHealthOutcome({ ok: false, error: "" }), "failed");
});

test("permission refusal: the engine's refusal text is recognised, other errors are not", () => {
  assert.equal(isPermissionRefusal("Claude requested permissions to use mcp__engram__mem_save, but you haven't granted it yet."), true);
  assert.equal(isPermissionRefusal("connect ECONNREFUSED 127.0.0.1:7437"), false);
  assert.equal(isPermissionRefusal("Failed to save: database is locked"), false);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("decision: tools listed and the health call answered is live, decided by tools and health", () => {
  const d = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "ok", userConfigured: true });
  assert.equal(d.backend, "live");
  assert.equal(d.decidedBy, "tools+health");
  assert.equal(d.server, "engram");
  assert.equal(d.permission, "ok");
  assert.equal(engramUsable(d), true);
});

test("decision: tools listed and the plugin server name is the one to call", () => {
  const d = detectMemoryBackend({ ...NONE, liveServer: "plugin_engram_engram", health: "ok" });
  assert.equal(d.server, "plugin_engram_engram");
});

test("decision: tools listed and no health call yet is live, decided by the tools alone", () => {
  const d = detectMemoryBackend({ ...NONE, liveServer: "engram", health: null });
  assert.equal(d.backend, "live");
  assert.equal(d.decidedBy, "tools");
  assert.equal(engramUsable(d), true);
});

test("decision: tools listed and the health call failed is configured-down, with no server to call", () => {
  const d = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "failed", userConfigured: true });
  assert.equal(d.backend, "configured-down");
  assert.equal(d.decidedBy, "health");
  assert.equal(d.server, null);
  assert.equal(engramUsable(d), false);
});

test("decision: a permission refusal is not down: Engram is live but not usable, and the panel can say why", () => {
  const d = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "permission" });
  assert.equal(d.backend, "live");
  assert.equal(d.decidedBy, "tools+health");
  assert.equal(d.permission, "refused");
  assert.equal(d.server, "engram");
  assert.equal(engramUsable(d), false);
});

test("decision: no tools but a user-scope server is configured-down, decided by the user config", () => {
  const d = detectMemoryBackend({ ...NONE, userConfigured: true });
  assert.deepEqual([d.backend, d.decidedBy, d.server], ["configured-down", "user-config", null]);
});

test("decision: no tools but the plugin is enabled is configured-down, decided by the plugin", () => {
  const d = detectMemoryBackend({ ...NONE, pluginEnabled: true, binaryVersion: "2.1.0" });
  assert.deepEqual([d.backend, d.decidedBy], ["configured-down", "plugin"]);
});

test("decision: only the binary is configured-down, decided by the binary", () => {
  const d = detectMemoryBackend({ ...NONE, binaryVersion: "2.1.0" });
  assert.deepEqual([d.backend, d.decidedBy], ["configured-down", "binary"]);
});

test("decision: nothing at all is absent, decided by none", () => {
  const d = detectMemoryBackend(NONE);
  assert.deepEqual([d.backend, d.decidedBy, d.server, d.permission], ["absent", "none", null, "unknown"]);
  assert.equal(engramUsable(d), false);
});

test("decision: a health result without tools listed does not make Engram live", () => {
  assert.equal(detectMemoryBackend({ ...NONE, health: "ok" }).backend, "absent");
});

// ---------------------------------------------------------------------------
// The auto-memory folder
// ---------------------------------------------------------------------------

test("slug: every non-alphanumeric character becomes a dash, as the engine does", () => {
  assert.equal(projectSlug("/home/dev/projects/app"), "-home-dev-projects-app");
  assert.equal(projectSlug("/Volumes/My Disk/a.b_c"), "-Volumes-My-Disk-a-b-c");
});

test("config dir: CLAUDE_CONFIG_DIR wins, else HOME/.claude, trailing slashes dropped", () => {
  assert.equal(claudeConfigDir({ claudeConfigDir: "/acct/one/", home: "/home/dev" }), "/acct/one");
  assert.equal(claudeConfigDir({ claudeConfigDir: null, home: "/home/dev/" }), "/home/dev/.claude");
  assert.equal(claudeConfigDir({ claudeConfigDir: "", home: "/home/dev" }), "/home/dev/.claude");
});

test("auto-memory dir: <config>/projects/<slug of the repo root>/memory", () => {
  assert.equal(
    autoMemoryDir({ configDir: "/acct/one", repoRoot: "/home/dev/projects/app", cwd: "/home/dev/projects/app/.claude/worktrees/agent-1" }),
    "/acct/one/projects/-home-dev-projects-app/memory",
  );
});

test("auto-memory dir: a worktree session uses the main checkout, not the worktree cwd", () => {
  const dir = autoMemoryDir({ configDir: "/acct", repoRoot: "/r/app", cwd: "/r/app-feature-x" });
  assert.equal(dir, "/acct/projects/-r-app/memory");
});

test("auto-memory dir: no repo falls back to the cwd", () => {
  assert.equal(autoMemoryDir({ configDir: "/acct", repoRoot: null, cwd: "/tmp/scratch" }), "/acct/projects/-tmp-scratch/memory");
});

test("auto-memory dir: the autoMemoryDirectory setting wins, with ~ expanded", () => {
  assert.equal(autoMemoryDir({ configDir: "/acct", repoRoot: "/r/app", cwd: "/r/app", setting: "~/mem/app/", home: "/home/dev" }), "/home/dev/mem/app");
  assert.equal(autoMemoryDir({ configDir: "/acct", repoRoot: "/r/app", cwd: "/r/app", setting: "/abs/mem" }), "/abs/mem");
});
