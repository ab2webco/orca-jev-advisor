// Integration tests for hooks/index.ts's own wiring -- the two-hook
// interaction (prompt.attachment's withhold decision, prompt.submit's own
// Jev calls and measurement record) that no pure src/core unit test can
// exercise on its own. JEVADV-4:
//
//   1. The listing must never be withheld unless a skill was actually
//      injected in its place THIS turn (today's bug: prompt.attachment
//      withheld on `active` alone, regardless of what prompt.submit
//      actually decided).
//   2. The tool-relevance path must be sampled the same way the skill path
//      already is (today's bug: it called Jev on every real prompt, no
//      sampling at all).
//   3. An active-mode decision records the activation metric
//      (src/core/mod_skills_readiness.ts) alongside it, so "active but
//      below readiness" is observable without gating anything.
//
// There is no existing harness for this file (unlike runtime.ts, whose
// exports are plain EngineInterface-shaped functions with no `on` to
// fake). This file is deliberately NOT under hooks/ (same reason
// runtime.test.ts lives one level up: hooks/tsconfig.json's `hooks/*.ts`
// include has no Node types, matching the hook sandbox's own "no DOM, no
// Node") and is a plain Node test file, picked up the same way
// runtime.test.ts already is by `node --test --experimental-strip-types`.
//
// Run with:
//   node --test adapters/claude/mod-skills/hooks.test.ts

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { register } from "./hooks/index.ts";
import { walkModSkillsClosure } from "../../../src/core/mod_skills_copy.ts";
import { isForkSampled } from "../../../src/core/memory_shadow.ts";
import { memorySpoolRoot } from "../../../src/core/memory_active.ts";
import { enqueueSave, spoolDonePath, spoolItemPath } from "../../../src/core/memory_spool.ts";

// ---------------------------------------------------------------------------
// A minimal fake of the Claude Code function-hooks host: only the `on`
// registration surface and the `$` namespaces hooks/index.ts's own imports
// actually touch (session, env, fs, clock, http, process, tool, ui).
// Structurally shaped, reached only through `unknown` casts at the call
// site -- never `any` -- same discipline runtime.test.ts's FakeEngine uses.
// ---------------------------------------------------------------------------

type Hook = (engine: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;

interface FakeHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
}

interface FakeHost {
  readonly handlers: Map<string, Hook>;
  readonly files: Map<string, string>;
  readonly fetchQueue: unknown[];
  readonly fetchCalls: { url: string; body?: string }[];
  toolList: { name: string; description: string; mcp: boolean }[];
  readonly statusLines: (string | undefined)[];
  /** Process env beyond HOME (which is fixed), for the router's CLAUDE_CONFIG_DIR / ANTHROPIC_* reads. */
  readonly env: Map<string, string>;
  /** `$.state`, by key (this plugin's own values only). */
  readonly state: Map<string, unknown>;
  /** `$.session.messages()` rows. */
  messages: { role: "user" | "assistant"; text: string; toolUses: unknown[] }[];
  /** When true, `$.session.messages()` rejects (a host failure). */
  failMessages: boolean;
  /** When true, `$.process.run` rejects (a missing or broken binary). */
  failProcess: boolean;
  /** `$.agent.list()` rows (0.6.8 T6); null makes the call reject, like a host without it. */
  agents: { id: string; status: string; type?: string; description?: string }[] | null;
  /** `$.session.usage().rateLimits`: the live figures Claude Code gives its status line (0.6.11 T6). */
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[];
  /** When true, `$.session.usage()` rejects. */
  failUsage: boolean;
  /** 0.6.23 T1: `$.session.root()`; null answers CWD. */
  root: string | null;
  /** 0.6.23 T1: what `git -C <dir> rev-parse --show-toplevel` / `branch --show-current` answer, by `<dir>`; any other dir exits 1. */
  readonly gitRepos: Map<string, { toplevel: string; branch: string }>;
  /** 0.6.23 T1: every `$.process.run` argv, joined with spaces. */
  readonly processCalls: string[];
  /** 0.6.29 T8: what `$.session.version()` answers; null makes it reject, like an engine that cannot say. */
  engineVersion: { version: string; base?: string } | null;
  /** 0.8.0 V3: what `$.clock.after` scheduled, in order; a test runs them with runTimers. */
  timers: (() => unknown)[];
  /** Track R and 0.9.0 C3: added to every `$.clock.now()` (on top of the usual millisecond tick), so a test can leave a gap between two turns. */
  clockOffsetMs: number;
  /** Track R: what `tail -n 300 <transcript>` prints, by transcript path; any other path exits 1. */
  readonly transcripts: Map<string, string>;
  /** 0.9.0 C2: the delay each `$.clock.after` was asked for, in order. */
  readonly timerDelays: number[];
  /** 0.9.0 C2: the `init` of every `$.process.run`, parallel to `processCalls`. */
  readonly processInits: ({ cwd?: string } | undefined)[];
  /** 0.9.0 C2: answers a `$.process.run` before the defaults; undefined leaves it to them. It may throw, like a binary that cannot start. */
  processHandler: ((argv: readonly string[], init?: { cwd?: string }) => { exitCode: number; stdout: string; stderr: string } | undefined) | null;
  /** 0.9.0 C3: every `$.ui.toast` text. */
  readonly toasts: string[];
  /** 0.9.0 C5: every `$.prompt.submit` input. */
  readonly submits: { text: string; asUser?: true }[];
  /** Memory (M8): every `$.model.complete` request, and the replies it answers in order; an empty queue rejects. */
  readonly modelCalls: Record<string, unknown>[];
  readonly modelQueue: unknown[];
  /** Memory (M8): every `$.model.fork` prompt, and its replies in order; an empty queue rejects. */
  readonly forkCalls: string[];
  readonly forkQueue: unknown[];
  /** Memory (M8): every `$.mcp.call`, and what it answers (a thrown Error rejects). */
  readonly mcpCalls: { server: string; tool: string; args?: Record<string, unknown> }[];
  /** It also gets the call's args (M9: the fake Engram reads them), and may return a promise that never settles, like a hung server. */
  mcpAnswer: (server: string, tool: string, args?: Record<string, unknown>) => unknown;
  /** M9: a `$.clock.sleep` of exactly this many ms resolves at once (a timeout that has run out); every other sleep never resolves. */
  resolveSleepMs: number | null;
  /** Memory (M8): `$.session.repo()`; null when not in a repository. */
  repo: { root: string } | null;
}

function makeFakeHost(): FakeHost {
  return {
    handlers: new Map<string, Hook>(),
    files: new Map<string, string>(),
    fetchQueue: [],
    fetchCalls: [],
    toolList: [],
    statusLines: [],
    env: new Map<string, string>(),
    state: new Map<string, unknown>(),
    messages: [],
    failMessages: false,
    failProcess: false,
    agents: null,
    rateLimits: [],
    failUsage: false,
    root: null,
    gitRepos: new Map<string, { toplevel: string; branch: string }>(),
    processCalls: [],
    engineVersion: null,
    timers: [],
    clockOffsetMs: 0,
    transcripts: new Map<string, string>(),
    timerDelays: [],
    processInits: [],
    processHandler: null,
    toasts: [],
    submits: [],
    modelCalls: [],
    modelQueue: [],
    forkCalls: [],
    forkQueue: [],
    mcpCalls: [],
    mcpAnswer: (server: string, tool: string) => {
      throw new Error(`fake host: $.mcp.call: no connected MCP tool "${tool}" on a server named "${server}"`);
    },
    resolveSleepMs: null,
    repo: null,
  };
}

/** Registers every `on(...)` call under its pattern name, ignoring the optional matcher (this module registers at most one handler per pattern). */
function fakeOn(host: FakeHost): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    const pattern = args[0] as string;
    const hook = (args.length >= 3 ? args[2] : args[1]) as Hook;
    host.handlers.set(pattern, hook);
  };
}

const HOME = "/home/dev";
const CONFIG_DIR = `${HOME}/.config/orca-supervisor`;
const CACHE_DIR = `${HOME}/.cache/orca-supervisor`;
const CWD = "/home/dev/Projects/sandbox";
// The fake clock starts at 2026-09-25T10:00Z and only moves a millisecond per read, so every record lands in this hour's files.
const SKILL_MEASUREMENTS_PATH = `${CACHE_DIR}/mod-skills-measurements-2026-09-25T10.jsonl`;
const TOOL_MEASUREMENTS_PATH = `${CACHE_DIR}/mod-tools-measurements-2026-09-25T10.jsonl`;
const LEGACY_SKILL_MEASUREMENTS_PATH = `${CACHE_DIR}/mod-skills-measurements.jsonl`;
const LEGACY_TOOL_MEASUREMENTS_PATH = `${CACHE_DIR}/mod-tools-measurements.jsonl`;
/** The engine's own limit: `$.fs.read` and `$.fs.write` reject above 4 MiB. */
const FS_LIMIT_BYTES = 4 * 1024 * 1024;

/** G8: a fetchQueue entry the fake fetch answers with this HTTP status (402: the key's account has no credit). */
function httpFailure(status: number): { readonly httpStatus: number } {
  return { httpStatus: status };
}

function isHttpFailure(value: unknown): value is { readonly httpStatus: number } {
  return typeof value === "object" && value !== null && "httpStatus" in value && typeof value.httpStatus === "number";
}

/** Builds a fake `$` (EngineInterface) backed by `host`'s mutable state. */
function makeFakeEngine(host: FakeHost): unknown {
  let clockNow = Date.parse("2026-09-25T10:00:00.000Z");
  return {
    session: {
      cwd: async () => CWD,
      root: async () => host.root ?? CWD,
      id: async () => "session-1",
      usage: async () => {
        if (host.failUsage) throw new Error("fake host: session.usage failed");
        return { startedAt: 0, context: {}, rateLimits: host.rateLimits };
      },
      messages: async () => {
        if (host.failMessages) throw new Error("fake host: session.messages failed");
        return host.messages;
      },
      version: async () => {
        if (host.engineVersion === null) throw new Error("fake host: session.version failed");
        return host.engineVersion;
      },
      repo: async () => (host.repo === null ? null : { root: host.repo.root, remote: null, internal: false, name: null }),
    },
    model: {
      complete: async (request: Record<string, unknown>) => {
        host.modelCalls.push(request);
        if (host.modelQueue.length === 0) throw new Error("fake host: model.complete queue exhausted");
        return host.modelQueue.shift();
      },
      fork: async (request: { prompt: string }) => {
        host.forkCalls.push(request.prompt);
        if (host.forkQueue.length === 0) throw new Error("fake host: model.fork queue exhausted");
        return host.forkQueue.shift();
      },
    },
    mcp: {
      call: async (server: string, tool: string, args?: Record<string, unknown>) => {
        host.mcpCalls.push({ server, tool, ...(args === undefined ? {} : { args }) });
        return host.mcpAnswer(server, tool, args);
      },
    },
    env: { get: async (name: string) => (name === "HOME" ? HOME : host.env.get(name)) },
    state: {
      get: async (ref: { key: string }) => ({ value: host.state.get(ref.key), version: host.state.has(ref.key) ? 1 : 0 }),
      set: async (ref: { key: string }, value: unknown) => {
        host.state.set(ref.key, value);
        return { isSet: true, version: 1 };
      },
    },
    fs: {
      // A path "exists" either as a literal file key, or as a directory
      // prefix of one (`.claude/skills` must exist once
      // `.claude/skills/foo/SKILL.md` is seeded, even though the directory
      // itself is never a literal key in `host.files`).
      exists: async (path: string) => host.files.has(path) || [...host.files.keys()].some((key) => key.startsWith(`${path}/`)),
      read: async (path: string) => {
        const content = host.files.get(path);
        if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        if (content.length > FS_LIMIT_BYTES) throw new Error("fake host: read over 4 MiB rejects");
        return content;
      },
      write: async (path: string, text: string) => {
        if (text.length > FS_LIMIT_BYTES) throw new Error("fake host: write over 4 MiB rejects");
        host.files.set(path, text);
      },
      list: async (path: string) => {
        const prefix = `${path}/`;
        const names = new Set<string>();
        for (const key of host.files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first !== undefined && first.length > 0) names.add(first);
        }
        return [...names].map((name) => ({ name, kind: host.files.has(`${prefix}${name}`) ? "file" : "dir" }));
      },
    },
    clock: {
      now: async () => clockNow++ + host.clockOffsetMs,
      // Never resolves: every race in these tests (Jev's own budget, and
      // resolveOrcaContext's process-run timeout) is won by the other side
      // (a fake fetch/process.run that always settles on its own), so a
      // sleep that never resolves never wins and never introduces flakiness.
      sleep: async (ms: number) => (ms === host.resolveSleepMs ? undefined : new Promise<void>(() => {})),
      // Held, never run on its own: a test that wants a timer's work runs it (runTimers).
      after: (ms: number, fn: () => unknown) => {
        host.timers.push(fn);
        host.timerDelays.push(ms);
        return { cancel: () => undefined };
      },
    },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        host.fetchCalls.push({ url, body: init?.body });
        const next = host.fetchQueue.shift();
        if (next === undefined) throw new Error("fake fetch: response queue exhausted -- a test queued fewer canned Jev answers than the code under test called");
        // G8: a queued `httpFailure(status)` answers that HTTP status instead of a Jev answer.
        if (isHttpFailure(next)) return { ok: false, status: next.httpStatus, headers: {}, text: "" } satisfies FakeHttpResponse;
        const response: FakeHttpResponse = { ok: true, status: 200, headers: {}, text: JSON.stringify(next) };
        return response;
      },
    },
    process: {
      // No real `orca` binary: resolveOrcaContext falls back to its
      // cwd-only shape, deterministically, on any non-success exit.
      run: async (argv: readonly string[], init?: { cwd?: string }) => {
        host.processCalls.push(argv.join(" "));
        host.processInits.push(init);
        if (host.failProcess) throw new Error("fake host: process.run failed");
        const scripted = host.processHandler?.(argv, init);
        if (scripted !== undefined) return scripted;
        // 0.6.23 T1: a seeded repository answers git's top level and branch.
        const repo = argv[0] === "git" && argv[1] === "-C" ? host.gitRepos.get(argv[2] ?? "") : undefined;
        if (repo !== undefined && argv[3] === "rev-parse") return { exitCode: 0, stdout: `${repo.toplevel}\n`, stderr: "" };
        if (repo !== undefined && argv[3] === "branch") return { exitCode: 0, stdout: `${repo.branch}\n`, stderr: "" };
        // Track R: the transcript tail the router reads its cache TTL from.
        const transcript = argv[0] === "tail" ? host.transcripts.get(argv[argv.length - 1] ?? "") : undefined;
        if (transcript !== undefined) return { exitCode: 0, stdout: transcript, stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    },
    tool: { list: async () => host.toolList },
    prompt: {
      submit: async (input: { text: string; asUser?: true }) => {
        host.submits.push(input);
        return { turnId: "turn-ci" };
      },
    },
    agent: {
      list: async () => {
        if (host.agents === null) throw new Error("fake host: agent.list unavailable");
        return host.agents;
      },
    },
    ui: {
      status: (text: string | undefined) => { host.statusLines.push(text); },
      toast: (text: string) => { host.toasts.push(text); },
      // The terminal's element table (0.6.14 T2): each constructor makes the plain-data element the engine would.
      resolve: () => ({
        Box: (props: Record<string, unknown>) => ({ type: "Box", props }),
        Text: (props: Record<string, unknown>) => ({ type: "Text", props }),
      }),
    },
  };
}

/** `next(e)` for prompt.submit's shape: what core resolves to absent any other plugin. */
async function promptSubmitNext(e: unknown): Promise<unknown> {
  return e;
}

/** `next(e)` for prompt.attachment: `{ text }` unchanged, the shape claude-code.d.ts documents. */
async function attachmentNext(e: unknown): Promise<{ text: string }> {
  return { text: (e as { text: string }).text };
}

function seedModSkillsConfig(host: FakeHost, switches: { active: boolean; activeTools: boolean }): void {
  host.files.set(`${CONFIG_DIR}/mod-skills-config.json`, JSON.stringify(switches));
}

function seedSamplingConfig(host: FakeHost, config: { enabled: boolean; sampleRate: number; dailyPromptCap: number }): void {
  host.files.set(`${CONFIG_DIR}/mod-skills-sampling-config.json`, JSON.stringify(config));
}

function seedProjectSkill(host: FakeHost, name: string, description: string, body: string): void {
  const markdown = `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
  host.files.set(`${CWD}/.claude/skills/${name}/SKILL.md`, markdown);
}

interface FakeChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface FakeNoulAnswer {
  type: "noul";
  noul: number;
}

function jevResponse(answers: Record<string, FakeChoiceAnswer | FakeNoulAnswer>): unknown {
  return { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

/** Registers hooks/index.ts's default export against a fresh fake host, with a fixed API key so resolveApiKey never needs env/fs. */
function loadHooks(host: FakeHost): { handlers: Map<string, Hook>; engine: unknown } {
  const on = fakeOn(host);
  register(on as never, { typesafeApiKey: "test-key" } as never);
  return { handlers: host.handlers, engine: makeFakeEngine(host) };
}

async function submitPrompt(handlers: Map<string, Hook>, engine: unknown, text: string): Promise<void> {
  const submit = handlers.get("prompt.submit");
  assert.ok(submit, "prompt.submit was never registered");
  await submit(engine, { text, wait: false, origin: { kind: "user" } }, promptSubmitNext);
}

/** Same as submitPrompt, but returns the (possibly context-carrying) event `next` actually received. */
async function submitPromptCapture(handlers: Map<string, Hook>, engine: unknown, text: string): Promise<{ context?: readonly string[] }> {
  const submit = handlers.get("prompt.submit");
  assert.ok(submit, "prompt.submit was never registered");
  let captured: { context?: readonly string[] } | undefined;
  await submit(
    engine,
    { text, wait: false, origin: { kind: "user" } },
    async (e: unknown) => {
      captured = e as { context?: readonly string[] };
      return e;
    },
  );
  assert.ok(captured, "next(e) was never called");
  return captured;
}

/** Fires `prompt.submit` purely to stamp the router's own origin state (JEV-061) -- the text is irrelevant here, only `origin.kind` matters to the router's point A/C gate. */
async function submitOrigin(handlers: Map<string, Hook>, engine: unknown, kind: string): Promise<void> {
  const submit = handlers.get("prompt.submit");
  assert.ok(submit, "prompt.submit was never registered");
  await submit(engine, { text: "irrelevant to the router's own gate", wait: false, origin: { kind } }, async (e: unknown) => e);
}

/** Fires `skill.prompt` (the model's own load, correlated by hooks/index.ts's `pendingMeasurementId`). */
async function fireSkillPrompt(handlers: Map<string, Hook>, engine: unknown, skill: string): Promise<void> {
  const skillPrompt = handlers.get("skill.prompt");
  assert.ok(skillPrompt, "skill.prompt was never registered");
  await skillPrompt(engine, { skill, origin: { kind: "user" } }, async (e: unknown) => e);
}

async function askAttachment(handlers: Map<string, Hook>, engine: unknown, realListing: string): Promise<{ text: string | null }> {
  const attachment = handlers.get("prompt.attachment");
  assert.ok(attachment, "prompt.attachment was never registered");
  const result = await attachment(engine, { type: "skill_listing", text: realListing, origin: { kind: "engine" } }, attachmentNext);
  return result as { text: string | null };
}

function lastDecisionRecord(host: FakeHost, path: string): Record<string, unknown> {
  const content = host.files.get(path);
  assert.ok(content, `${path} was never written`);
  const lines = content.split("\n").filter((line) => line.length > 0);
  const decisions = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.type === "decision");
  const last = decisions.at(-1);
  assert.ok(last, `no decision record found in ${path}`);
  return last;
}

const REAL_LISTING = "- archify: draws diagrams\n- graft-helper: explores this codebase with graft\n";

// ---------------------------------------------------------------------------
// Requirement 1: never withhold the listing without a replacement
// ---------------------------------------------------------------------------

test("active mode, Jev picks no skill: the full listing is delivered, not withheld", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 }); // tool path (measurement mode) must never sample
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Use graft to answer.");
  const { handlers, engine } = loadHooks(host);

  // Stage 1 only: the gate noul is below DEFAULT_GATE_THRESHOLD (0.3), so
  // decideSkill returns { name: null } before stage 2 is ever attempted --
  // exactly one Jev call for the skill path.
  host.fetchQueue.push(jevResponse({
    which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
    skill_needed: { type: "noul", noul: 0.05 },
  }));

  await submitPrompt(handlers, engine, "what does this file do");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.deepEqual(attachment, { text: REAL_LISTING }, "today's bug: active mode withheld the listing even though Jev picked nothing");
  assert.equal(host.fetchCalls.length, 1, "only stage 1 should have run (tool path must not have sampled)");

  const record = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal(record.mode, "active");
  assert.equal((record.decision as { name: string | null }).name, null);
  assert.equal(record.listingWithheld, false, "a turn that delivered the listing must never claim it was withheld");
});

test("active mode, Jev picks a skill: that skill is injected and the listing is withheld", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Read graft_repo_map first.");
  const { handlers, engine } = loadHooks(host);

  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.8 },
    }),
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 },
      "fits::graft-helper": { type: "noul", noul: 0.9 },
    }),
  );

  await submitPrompt(handlers, engine, "how does the auth module work");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.equal(attachment.text, null, "a real pick must withhold the engine's own listing");
  assert.equal(host.fetchCalls.length, 2, "both stages should have run");

  const record = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal((record.decision as { name: string | null }).name, "graft-helper");
  assert.equal(record.listingWithheld, true);
});

test("active mode, Jev picks a skill but its SKILL.md can't be read: the listing is delivered, not withheld", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  const { handlers, engine } = loadHooks(host);

  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.8 },
    }),
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 },
      "fits::graft-helper": { type: "noul", noul: 0.9 },
    }),
  );

  // Fail only the THIRD read of this exact skill path, keyed by path
  // rather than by overall call order (an unrelated config read -- the
  // sampling config, the active-mode switches -- must never accidentally
  // consume this budget): 1st is listSkillInventory's own frontmatter
  // read, 2nd is stage 2's excerpt read, 3rd is the final read that builds
  // the injected block -- the one this test wants to fail.
  const skillPath = `${CWD}/.claude/skills/graft-helper/SKILL.md`;
  let skillReadCount = 0;
  const baseEngine = engine as { fs: { read: (path: string) => Promise<string> } };
  const originalRead = baseEngine.fs.read.bind(baseEngine.fs);
  baseEngine.fs.read = async (path: string) => {
    if (path === skillPath) {
      skillReadCount += 1;
      if (skillReadCount === 3) throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return originalRead(path);
  };

  await submitPrompt(handlers, engine, "how does the auth module work");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.deepEqual(attachment, { text: REAL_LISTING }, "a failed SKILL.md read must never leave the model with neither the listing nor the skill");
  const record = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal((record.decision as { name: string | null }).name, "graft-helper", "Jev's pick is still recorded");
  assert.equal(record.listingWithheld, false, "nothing was actually injected, so this must not claim otherwise");
});

// ---------------------------------------------------------------------------
// Requirement 2: the tool-relevance path is now sampled too
// ---------------------------------------------------------------------------

test("measurement mode, prompt not sampled: the listing is delivered and Jev is never called (skills or tools)", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 0, dailyPromptCap: 40 }); // sampleRate 0: never sampled, deterministically
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  // No .claude/skills directory at all: the skill closure would bail on an
  // empty inventory regardless, so this test isolates the sampling gate to
  // the tool closure, which had none before this fix.
  const { handlers, engine } = loadHooks(host);

  await submitPrompt(handlers, engine, "run the build");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.deepEqual(attachment, { text: REAL_LISTING });
  assert.equal(host.fetchCalls.length, 0, "today's bug: the tool path called Jev on every prompt with no sampling at all");
  assert.equal(host.files.has(SKILL_MEASUREMENTS_PATH), false);
});

test("measurement mode, tool path respects sampleRate: sampled at rate 1 with room under the cap, Jev is called", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  const { handlers, engine } = loadHooks(host);

  // Gate closed at stage 1: only one call needed to prove the path ran.
  host.fetchQueue.push(jevResponse({
    which: { type: "choice", choice: "Bash", probabilities: { Bash: 0.6 }, confidence: 0.6 },
    needsOneTool: { type: "noul", noul: 0.1 },
  }));

  await submitPrompt(handlers, engine, "run the build");

  assert.equal(host.fetchCalls.length, 1, "sampleRate 1 with room under the cap must let the tool path spend its Jev call");
});

test("measurement mode, tool path respects dailyPromptCap: cap already at 0, Jev is never called even at sampleRate 1", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 0 });
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  const { handlers, engine } = loadHooks(host);

  await submitPrompt(handlers, engine, "run the build");

  assert.equal(host.fetchCalls.length, 0, "a dailyPromptCap of 0 must be honored even at sampleRate 1");
});

// ---------------------------------------------------------------------------
// Requirement 3: an active run below readiness is recorded, never enforced
// ---------------------------------------------------------------------------

test("active mode with an empty measurement log: the decision records readiness.ready === false, but still runs", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  const { handlers, engine } = loadHooks(host);

  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.8 },
    }),
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 },
      "fits::graft-helper": { type: "noul", noul: 0.9 },
    }),
  );

  await submitPrompt(handlers, engine, "how does the auth module work");

  const record = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal(record.mode, "active");
  assert.deepEqual(record.readiness, { ready: false, comparableShortfall: 1000, matchRateMet: null, reason: "not-enough-samples" });
  // Never enforced: the switch stayed on, active mode still ran and still
  // injected its pick (readiness only records the state, per JEVADV-4's
  // own scope -- the panel owns whether the switch itself should be off).
  assert.equal(record.listingWithheld, true);
});

// ---------------------------------------------------------------------------
// JEVADV-38 R3-shared-roll-outside-fail-open: the shared sampling roll
// (samplingConfig/today/promptsSampledToday/sampled) must fail open like
// everything else in this hook -- a rejected $.clock.now, config read or
// counter read must never escape prompt.submit itself.
// ---------------------------------------------------------------------------

test("the shared sampling roll's own failure fails open as not sampled: no throw, no Jev call, listing delivered", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  const { handlers, engine } = loadHooks(host);

  // The roll's own `$.clock.now()` call (building `today`) is the second
  // clock read of the whole prompt.submit run, after K0's typing lead time
  // (whose own failure the K0b tests cover) -- fail only that one call, so
  // everything after the roll (timestamps inside the two closures, should
  // either of them still run) keeps behaving normally.
  const baseEngine = engine as { clock: { now: () => Promise<number> } };
  const originalNow = baseEngine.clock.now.bind(baseEngine.clock);
  let callCount = 0;
  baseEngine.clock.now = async () => {
    callCount += 1;
    if (callCount === 2) throw new Error("clock unavailable");
    return originalNow();
  };

  await assert.doesNotReject(
    submitPrompt(handlers, engine, "what does this file do"),
    "today's bug: a rejected clock read in the shared sampling roll escaped prompt.submit unhandled",
  );
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.deepEqual(attachment, { text: REAL_LISTING }, "a failed roll must fail open as 'not sampled', so measurement mode delivers the real listing");
  assert.equal(host.fetchCalls.length, 0, "not sampled means neither closure spends a Jev call");
  assert.equal(host.files.has(SKILL_MEASUREMENTS_PATH), false, "an unsampled prompt records nothing");
  assert.equal(host.files.has(TOOL_MEASUREMENTS_PATH), false, "an unsampled prompt records nothing");
});

// ---------------------------------------------------------------------------
// JEVADV-38 R3-readiness-cached-stale: readiness must be the honest
// per-decision value, not a snapshot cached once at session start.
// ---------------------------------------------------------------------------

test("readiness reflects a decision recorded earlier in this same session, not a session-start snapshot", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  const { handlers, engine } = loadHooks(host);

  // First prompt: gate closes at stage 1 (skill not needed) -- one Jev
  // call, decision.name stays null. The log is still empty at the moment
  // this decision's own readiness is computed, so it must report the full
  // shortfall.
  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.05 },
    }),
  );
  await submitPrompt(handlers, engine, "first prompt");
  const firstRecord = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal((firstRecord.readiness as { comparableShortfall: number }).comparableShortfall, 1000);

  // The model loads a skill on its own -- turns the first decision
  // "comparable" (a decision + a same-id observation now both sit in the
  // log), independently of what Jev picked.
  await fireSkillPrompt(handlers, engine, "graft-helper");

  // Second prompt: another measurement decision. Its own readiness
  // snapshot must be recomputed from the log as it now stands (one
  // comparable pair already on disk), not reuse the empty-log snapshot
  // read for the FIRST decision.
  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.05 },
    }),
  );
  await submitPrompt(handlers, engine, "second prompt");
  const secondRecord = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal(
    (secondRecord.readiness as { comparableShortfall: number }).comparableShortfall,
    999,
    "today's bug: readiness is cached once per process and never reflects a decision made earlier in the same session",
  );
});

// ---------------------------------------------------------------------------
// JEVADV-62: a measurement log must never go silent. Seen live on
// 2026-09-29: mod-tools-measurements.jsonl reached 4,194,231 bytes, every
// append (a whole-file rewrite) crossed the engine's 4 MiB limit and was
// swallowed, and nothing was recorded again.
// ---------------------------------------------------------------------------

function fullLegacyLog(pair: readonly Record<string, unknown>[]): string {
  const head = pair.map((row) => `${JSON.stringify(row)}\n`).join("");
  const filler = `${JSON.stringify({ type: "decision", id: "old", at: "2026-09-20T08:00:00.000Z", mode: "active", pad: "x".repeat(200) })}\n`;
  return head + filler.repeat(Math.floor((FS_LIMIT_BYTES - 64 - head.length) / filler.length));
}

test("a legacy log at the 4 MiB limit: new records land in this hour's own file and the old history still counts", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  const legacySkills = fullLegacyLog([
    { type: "decision", id: "legacy", at: "2026-09-24T08:00:00.000Z", mode: "measurement", decision: { name: "graft-helper" } },
    { type: "observation", id: "legacy", at: "2026-09-24T08:01:00.000Z", skill: "graft-helper" },
  ]);
  const legacyTools = fullLegacyLog([]);
  host.files.set(LEGACY_SKILL_MEASUREMENTS_PATH, legacySkills);
  host.files.set(LEGACY_TOOL_MEASUREMENTS_PATH, legacyTools);
  const { handlers, engine } = loadHooks(host);

  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.05 },
    }),
    jevResponse({ which: { type: "choice", choice: "Bash", probabilities: { Bash: 0.6 }, confidence: 0.6 }, needsOneTool: { type: "noul", noul: 0.1 } }),
  );
  await submitPrompt(handlers, engine, "what does this file do");

  const skillRecord = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal(skillRecord.mode, "measurement", "today's bug: the decision was lost because the whole-file rewrite crossed 4 MiB");
  assert.equal(
    (skillRecord.readiness as { comparableShortfall: number }).comparableShortfall,
    999,
    "readiness must still fold the comparable pair recorded in the legacy file",
  );
  assert.ok(host.files.has(TOOL_MEASUREMENTS_PATH), "the tool decision lands in this hour's own tool file");
  assert.equal(host.files.get(LEGACY_SKILL_MEASUREMENTS_PATH), legacySkills, "the legacy file is only ever read, never rewritten");
  assert.equal(host.files.get(LEGACY_TOOL_MEASUREMENTS_PATH), legacyTools, "the legacy file is only ever read, never rewritten");
});

test("the daily sampling cap counts today's hourly files, not only the legacy file", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 2 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  const today = [
    { type: "decision", id: "a", at: "2026-09-25T08:00:00.000Z", mode: "measurement" },
    { type: "decision", id: "b", at: "2026-09-25T09:00:00.000Z", mode: "measurement" },
  ];
  host.files.set(`${CACHE_DIR}/mod-skills-measurements-2026-09-25T08.jsonl`, `${JSON.stringify(today[0])}\n`);
  host.files.set(`${CACHE_DIR}/mod-skills-measurements-2026-09-25T09.jsonl`, `${JSON.stringify(today[1])}\n`);
  const { handlers, engine } = loadHooks(host);

  await submitPrompt(handlers, engine, "what does this file do");

  assert.equal(host.fetchCalls.length, 0, "two samples already recorded today in hourly files: the cap of 2 is reached");
  assert.equal(host.files.has(SKILL_MEASUREMENTS_PATH), false);
});

// ---------------------------------------------------------------------------
// JEVADV-38 R3-missing-mixed-mode-and-stale-flag-tests
// ---------------------------------------------------------------------------

test("mixed mode: skill active + tool measurement, both run independently in the same turn", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Read graft_repo_map first.");
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  const { handlers, engine } = loadHooks(host);

  host.fetchQueue.push(
    // Skill path (active): both stages, Jev picks graft-helper.
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.8 },
    }),
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 },
      "fits::graft-helper": { type: "noul", noul: 0.9 },
    }),
    // Tool path (measurement, sampled): gate closes at stage 1.
    jevResponse({
      which: { type: "choice", choice: "Bash", probabilities: { Bash: 0.6 }, confidence: 0.6 },
      needsOneTool: { type: "noul", noul: 0.1 },
    }),
  );

  await submitPrompt(handlers, engine, "how does the auth module work");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.equal(attachment.text, null, "skill active mode still withholds the listing for its own pick");
  assert.equal(host.fetchCalls.length, 3, "both paths must have run: 2 skill calls + 1 tool call");

  const skillRecord = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal(skillRecord.mode, "active");
  assert.equal((skillRecord.decision as { name: string | null }).name, "graft-helper");

  const toolRecord = lastDecisionRecord(host, TOOL_MEASUREMENTS_PATH);
  assert.equal(toolRecord.mode, "measurement", "activeTools stayed false: the tool path must have recorded a measurement-mode decision, not active");
  assert.equal((toolRecord.decision as { name: string | null }).name, null);
});

test("the reverse: skill measurement + tool active, both run independently in the same turn", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: true });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  const { handlers, engine } = loadHooks(host);

  host.fetchQueue.push(
    // Skill path (measurement, sampled): gate closes at stage 1.
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.05 },
    }),
    // Tool path (active): both stages, Jev picks Bash.
    jevResponse({
      which: { type: "choice", choice: "Bash", probabilities: { Bash: 0.9 }, confidence: 0.9 },
      needsOneTool: { type: "noul", noul: 0.8 },
    }),
    jevResponse({
      which: { type: "choice", choice: "Bash", probabilities: { Bash: 0.95 }, confidence: 0.9 },
      "fits::Bash": { type: "noul", noul: 0.9 },
    }),
  );

  const captured = await submitPromptCapture(handlers, engine, "run the build");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.deepEqual(attachment, { text: REAL_LISTING }, "skill path stayed in measurement mode: nothing to withhold the listing for");
  assert.equal(host.fetchCalls.length, 3, "both paths must have run: 1 skill call + 2 tool calls");
  assert.ok(
    (captured.context ?? []).some((block) => block.includes("<tool_relevance>") && block.includes("Bash")),
    "tool active mode must inject its pick as advice",
  );

  const skillRecord = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal(skillRecord.mode, "measurement");

  const toolRecord = lastDecisionRecord(host, TOOL_MEASUREMENTS_PATH);
  assert.equal(toolRecord.mode, "active");
  assert.equal((toolRecord.decision as { name: string | null }).name, "Bash");
});

test("a withheld turn followed by a restored turn: pendingListingWithheld never leaks across turns", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Read graft_repo_map first.");
  const { handlers, engine } = loadHooks(host);

  // Turn 1: Jev picks a skill -- the listing is withheld.
  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.8 },
    }),
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 },
      "fits::graft-helper": { type: "noul", noul: 0.9 },
    }),
  );
  await submitPrompt(handlers, engine, "how does the auth module work");
  const firstAttachment = await askAttachment(handlers, engine, REAL_LISTING);
  assert.equal(firstAttachment.text, null, "turn 1 must withhold: Jev picked a skill and its SKILL.md was read");

  // Turn 2, same session (same registered hook instance, same closure
  // state): Jev picks nothing this time -- the listing must be delivered,
  // never withheld by a flag left over from turn 1.
  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.05 },
    }),
  );
  await submitPrompt(handlers, engine, "what time is it");
  const secondAttachment = await askAttachment(handlers, engine, REAL_LISTING);
  assert.deepEqual(secondAttachment, { text: REAL_LISTING }, "today's bug: a stale pendingListingWithheld from turn 1 would withhold turn 2's listing too");
});

// ---------------------------------------------------------------------------
// JEV-060 slice 1, T1: turn.step -- a pass-through hook that records per-step
// token usage to the current hour's own turn-usage-*.jsonl file and never changes the event or the result
// beneath it. `next` for a streaming event is itself an async generator
// (HookStream): the fakes below mirror that shape directly rather than the
// plain-Promise `next` the other hooks in this file use.
// ---------------------------------------------------------------------------

// The fake clock (see makeFakeEngine) starts at 2026-09-25T10:00:00.000Z and
// only ever advances by whole milliseconds within a test, so every record
// these tests produce falls in the "2026-09-25T10" hour bucket.
const TURN_USAGE_HOUR = "2026-09-25T10";
const TURN_USAGE_PATH = `${CACHE_DIR}/turn-usage-${TURN_USAGE_HOUR}.jsonl`;

/** Runs a `turn.step` hook's own generator (as `on('turn.step', ...)` returns) to completion, returning what it `return`ed. */
async function drainTurnStep(stream: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  for (;;) {
    const step = await stream.next();
    if (step.done) return step.value;
  }
}

function turnStepEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnId: "turn-1",
    index: 0,
    model: "claude-sonnet-5",
    effort: "high",
    messageCount: 3,
    ...overrides,
  };
}

function turnStepResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnId: "turn-1",
    index: 0,
    answer: "done",
    toolUses: [],
    stopReason: "end_turn",
    usage: {
      model: "claude-sonnet-5-20260101",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 200,
    },
    ...overrides,
  };
}

function lastTurnUsageLine(host: FakeHost): Record<string, unknown> {
  const content = host.files.get(TURN_USAGE_PATH);
  assert.ok(content, "the current hour's turn-usage file was never written");
  const lines = content.split("\n").filter((line) => line.length > 0);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

test("turn.step: pass-through -- e is never rewritten and next(e)'s result is returned unchanged", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");

  const event = turnStepEvent();
  const result = turnStepResult();
  async function* fakeNext(e: unknown): AsyncGenerator<unknown, unknown> {
    assert.deepEqual(e, event, "the hook must call next with the event unchanged");
    return result;
  }

  const stream = hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>;
  const returned = await drainTurnStep(stream);

  assert.deepEqual(event, turnStepEvent(), "the hook must never mutate e");
  assert.deepEqual(returned, result, "the hook must yield/return next(e)'s result unchanged");
});

test("turn.step: appends exactly one usage line to the current hour's file, main loop", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");

  const event = turnStepEvent();
  const result = turnStepResult();
  async function* fakeNext(): AsyncGenerator<unknown, unknown> {
    return result;
  }

  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);

  const content = host.files.get(TURN_USAGE_PATH);
  assert.ok(content, "the current hour's turn-usage file was never written");
  const lines = content.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, "exactly one line should have been appended");

  const record = lastTurnUsageLine(host);
  assert.equal(record.agent, "main");
  assert.equal(record.model, "claude-sonnet-5-20260101");
  assert.equal(record.effort, "high");
  assert.equal(record.input, 100);
  assert.equal(record.output, 20);
  assert.equal(record.cacheRead, 5000);
  assert.equal(record.cacheWrite, 200);
  assert.equal(record.stopReason, "end_turn");
  assert.equal(record.account, "home", "no CLAUDE_CONFIG_DIR in the fake env: falls back to 'home'");
  assert.equal(typeof record.at, "string");
});

test("turn.step: a subagent's step is recorded as agent 'subagent'", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");

  const event = turnStepEvent({ agentId: "sub-1" });
  const result = turnStepResult();
  async function* fakeNext(): AsyncGenerator<unknown, unknown> {
    return result;
  }

  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);

  assert.equal(lastTurnUsageLine(host).agent, "subagent");
});

test("turn.step: account id is parsed from CLAUDE_CONFIG_DIR when it matches the claude-accounts uuid convention", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");

  const baseEngine = engine as { env: { get: (name: string) => Promise<string | undefined> } };
  baseEngine.env.get = async (name: string) =>
    name === "CLAUDE_CONFIG_DIR"
      ? "/home/dev/Library/Application Support/orca/claude-accounts/cccccccc-1234/auth"
      : name === "HOME"
        ? HOME
        : undefined;

  const event = turnStepEvent();
  const result = turnStepResult();
  async function* fakeNext(): AsyncGenerator<unknown, unknown> {
    return result;
  }

  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);

  assert.equal(lastTurnUsageLine(host).account, "cccccccc-1234");
});

test("turn.step: an append only ever touches the current hour's file, never an older hour's", async () => {
  const host = makeFakeHost();
  const olderHourPath = `${CACHE_DIR}/turn-usage-2026-09-25T09.jsonl`;
  const olderHourContent = `${JSON.stringify({ seq: "kept-from-a-previous-hour" })}\n`;
  host.files.set(olderHourPath, olderHourContent);
  const { handlers, engine } = loadHooks(host);
  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");

  const event = turnStepEvent();
  const result = turnStepResult();
  async function* fakeNext(): AsyncGenerator<unknown, unknown> {
    return result;
  }

  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);

  assert.equal(
    host.files.get(olderHourPath),
    olderHourContent,
    "an older hour's file must never be read or rewritten by a step recorded in the current hour",
  );
  const currentHourContent = host.files.get(TURN_USAGE_PATH);
  assert.ok(currentHourContent, "the current hour's own file should have been written");
  const lines = (currentHourContent as string).split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, "exactly one line should have been appended to the current hour's file");
});

test("turn.step: turn-usage record's project is null when no prompt has resolved orcaContextCache yet this session (JEVADV-63)", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");

  const event = turnStepEvent();
  const result = turnStepResult();
  async function* fakeNext(): AsyncGenerator<unknown, unknown> {
    return result;
  }
  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);

  assert.equal(lastTurnUsageLine(host).project, null, "not yet known this session -- an honest null, not a bug");
});

test("turn.step: turn-usage record carries the resolved project once orcaContextCache is warm (JEVADV-63)", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Use graft to answer.");
  const { handlers, engine } = loadHooks(host);

  // Stage 1 only, same shape as the "active mode, Jev picks no skill" test:
  // exactly one Jev call, and it still reaches the orcaContextCache line
  // regardless of what it decides (the inventory is non-empty).
  host.fetchQueue.push(jevResponse({
    which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
    skill_needed: { type: "noul", noul: 0.05 },
  }));
  await submitPrompt(handlers, engine, "what does this file do");

  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");
  const event = turnStepEvent();
  const result = turnStepResult();
  async function* fakeNext(): AsyncGenerator<unknown, unknown> {
    return result;
  }
  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);

  assert.equal(
    lastTurnUsageLine(host).project,
    "sandbox",
    "no real orca binary in the fake host -- resolveOrcaContext falls back to cwd, whose last path segment names the project",
  );
});

// ---------------------------------------------------------------------------
// JEV-060 slice 2, T6: the model router's session-start decision (point A)
// and its stickiness, on the same turn.step hook as the usage recorder.
// ---------------------------------------------------------------------------

const ACCOUNT_DIR = "/orca/claude-accounts/acct-1/auth";
const ROUTER_DECISIONS_PATH = `${CACHE_DIR}/model-router-decisions-${TURN_USAGE_HOUR}.jsonl`;

// The simple tier here is a Haiku 4.5 row an install chose to keep (an edited row is never migrated): it takes no
// effort. The default ladder, Haiku 5.5, is DEFAULT_MODELS below.
const SEED_MODELS = [
  { id: "claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1", rank: 1, agentModel: "fable", source: "", available: false },
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", rank: 2, agentModel: "opus", source: "", available: true },
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", rank: 3, agentModel: "sonnet", source: "", available: true },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Claude Haiku 4.5", rank: 4, agentModel: "haiku", source: "", available: true, tier: "simple", supportsEffort: false },
];
const DEFAULT_MODELS = SEED_MODELS.map((row) => (row.id === "claude-haiku-4-5-20251001" ? { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", rank: 4, agentModel: "haiku", source: "", available: true } : row));

function seedRouterAccount(host: FakeHost, vaultEnv: Record<string, string> = {}, models: readonly unknown[] = SEED_MODELS): void {
  host.env.set("CLAUDE_CONFIG_DIR", ACCOUNT_DIR);
  host.files.set(`${ACCOUNT_DIR}/settings.json`, JSON.stringify({ env: vaultEnv }));
  host.files.set(`${CONFIG_DIR}/models-catalog.json`, JSON.stringify({ active: false, ready: false, models }));
}

function loadHooksWith(host: FakeHost, options: Record<string, unknown>): { handlers: Map<string, Hook>; engine: unknown } {
  const on = fakeOn(host);
  register(on as never, { typesafeApiKey: "test-key", ...options } as never);
  return { handlers: host.handlers, engine: makeFakeEngine(host) };
}

function tierAnswer(tier: string, confidence = 0.9): unknown {
  return jevResponse({ tier: { type: "choice", choice: tier, probabilities: { [tier]: confidence }, confidence } });
}

/** Runs one turn.step through the hook and returns the event `next` received. */
async function stepThrough(handlers: Map<string, Hook>, engine: unknown, event: Record<string, unknown>, result: Record<string, unknown> = turnStepResult()): Promise<Record<string, unknown>> {
  const hook = handlers.get("turn.step");
  assert.ok(hook, "turn.step was never registered");
  let seen: Record<string, unknown> | null = null;
  async function* fakeNext(e: unknown): AsyncGenerator<unknown, unknown> {
    seen = e as Record<string, unknown>;
    return result;
  }
  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);
  assert.ok(seen !== null, "next was never called");
  return seen;
}

function routerDecisionLines(host: FakeHost): Record<string, unknown>[] {
  const content = host.files.get(ROUTER_DECISIONS_PATH) ?? "";
  return content.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const FRESH_START = { index: 0, model: "claude-opus-5-5", effort: "high" };

test("router, measure (the default): decides and logs at session start, changes nothing", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);

  const event = turnStepEvent(FRESH_START);
  const seen = await stepThrough(handlers, engine, event);
  assert.deepEqual(seen, event);

  const [decision] = routerDecisionLines(host);
  assert.ok(decision, "no decision was logged");
  assert.equal(decision.point, "start");
  assert.equal(decision.tier, "simple");
  assert.equal(decision.current, "claude-opus-5-5");
  assert.equal(decision.proposed, "claude-haiku-4-5-20251001");
  assert.equal(decision.applied, false);
  assert.equal(decision.account, "acct-1");
  assert.equal(decision.quotaBand, "normal");
  for (const key of ["at", "confidence", "reason", "guard", "contextTokens", "switchCost", "stepSaving", "expectedSteps"]) assert.ok(key in decision, key);
  assert.equal(JSON.stringify(decision).includes("what time"), false, "no prompt text in the decision log");
  assert.equal(host.statusLines.at(-1), "jev · would use: Haiku 4.5");
});

test("router quota: the live 5-hour and 7-day figures set the band, and the record says live (0.6.11 T6)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.rateLimits = [
    { kind: "five_hour", percentUsed: 96.5, resetsAt: "2026-09-25T13:00:00.000Z" },
    { kind: "seven_day", percentUsed: 30, resetsAt: "2026-09-30T00:00:00.000Z" },
  ];
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.quotaBand, "strong-economy");
  assert.equal(decision?.quotaSource, "live");
  const sent = host.fetchCalls.map((call) => call.body ?? "").join("\n");
  assert.ok(sent.includes("strong-economy"), "Jev is told the live pressure");
});

test("router quota: with no live reading the fresh Orca mirror decides, and the record says mirror", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/quota.json`, JSON.stringify({ checkedAt: "2026-09-25T09:55:00.000Z", accounts: [{ id: "acct-1", status: "ok", sessionUsedPercent: 12, weeklyUsedPercent: 85, resetsAt: null }] }));
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.quotaBand, "economy");
  assert.equal(decision?.quotaSource, "mirror");
});

test("router quota: a failing session.usage falls back to the mirror, and to none without one", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.failUsage = true;
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.quotaBand, "normal");
  assert.equal(decision?.quotaSource, "none");
});

test("router decision record: carries the resolved project once orcaContextCache is warm (JEVADV-63)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Use graft to answer.");
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.05 },
    }),
    tierAnswer("simple"),
  );
  const { handlers, engine } = loadHooks(host);

  // "composer" (not "user" -- see model_router_origin.ts's closed set),
  // so the router's own personhood gate still lets point A decide below;
  // this call still runs the skill closure (active mode, non-empty
  // inventory) and so still warms orcaContextCache.
  await submitOrigin(handlers, engine, "composer");
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));

  const [decision] = routerDecisionLines(host);
  assert.ok(decision, "no decision was logged");
  assert.equal(decision.project, "sandbox");
});

test("router decision record: project is null when no prompt has resolved orcaContextCache yet this session (JEVADV-63)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);

  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));

  const [decision] = routerDecisionLines(host);
  assert.ok(decision, "no decision was logged");
  assert.equal(decision.project, null);
});

test("router, active: a simple first prompt runs on Haiku with no effort, and every later step sticks to it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  const first = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(first.model, "claude-haiku-4-5-20251001");
  assert.equal("effort" in first, false);
  assert.equal(routerDecisionLines(host)[0]?.applied, true);
  assert.equal(host.statusLines.at(-1), "jev · model: Haiku 4.5");

  host.messages = [...host.messages, { role: "assistant", text: "", toolUses: [] }];
  const second = await stepThrough(handlers, engine, turnStepEvent({ ...FRESH_START, index: 1 }));
  assert.equal(second.model, "claude-haiku-4-5-20251001");
  assert.equal("effort" in second, false);
  assert.equal(host.fetchCalls.length, 1, "a later step never asks Jev again");
});

test("router, active: on the default ladder a simple first prompt runs on Haiku 5.5 at medium effort", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host, {}, DEFAULT_MODELS);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  const first = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(first.model, "claude-haiku-5-5");
  assert.equal(first.effort, "medium", "Haiku 5.5 takes effort, so the simple tier's own is sent");
  assert.equal(host.statusLines.at(-1), "jev · model: Haiku 5.5 · medium effort");

  host.messages = [...host.messages, { role: "assistant", text: "", toolUses: [] }];
  const second = await stepThrough(handlers, engine, turnStepEvent({ ...FRESH_START, index: 1 }));
  assert.equal(second.model, "claude-haiku-5-5");
  assert.equal(second.effort, "medium");
});

const ENGINE_VERSION_PATH = `${CACHE_DIR}/engine-version.json`;

test("0.6.29 T8, active: an engine older than Haiku 5.5's floor keeps the simple tier on Haiku 4.5, with no effort, and the row says why", async () => {
  const host = makeFakeHost();
  host.engineVersion = { version: "2.1.292", base: "2.1.292" };
  seedRouterAccount(host, {}, DEFAULT_MODELS);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  const first = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(first.model, "claude-haiku-4-5-20251001");
  assert.equal("effort" in first, false, "Haiku 4.5 takes no effort");
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.proposed, "claude-haiku-4-5-20251001");
  assert.equal(decision?.fallbackReason, "engine-too-old");
  assert.equal("engineVersionUnknown" in (decision ?? {}), false);
  assert.equal(host.statusLines.at(-1), "jev · model: Haiku 4.5");
});

test("0.6.29 T8, active: an engine at or past the floor, a dev build of it included, runs Haiku 5.5 with no note", async () => {
  for (const version of ["2.1.293", "2.1.296", "2.1.293-dev.20260920.t101500.sha1a2b3c4"]) {
    const host = makeFakeHost();
    host.engineVersion = { version };
    seedRouterAccount(host, {}, DEFAULT_MODELS);
    host.messages = [{ role: "user", text: "hi", toolUses: [] }];
    host.fetchQueue.push(tierAnswer("simple"));
    const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
    const first = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
    assert.equal(first.model, "claude-haiku-5-5", version);
    const [decision] = routerDecisionLines(host);
    assert.equal("fallbackReason" in (decision ?? {}), false);
    assert.equal("engineVersionUnknown" in (decision ?? {}), false);
  }
});

test("0.6.29 T8, active: an engine that cannot say its version is taken to run Haiku 5.5, and the row says the version was unknown", async () => {
  const host = makeFakeHost();
  host.engineVersion = null;
  seedRouterAccount(host, {}, DEFAULT_MODELS);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(first.model, "claude-haiku-5-5");
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.engineVersionUnknown, true);
  assert.equal("fallbackReason" in (decision ?? {}), false);
  assert.equal(host.files.has(ENGINE_VERSION_PATH), false, "nothing is recorded for the Agent hook when the version is unknown");
});

test("0.6.29 T8, measure: the decision names the model the engine can run, and nothing is sent", async () => {
  const host = makeFakeHost();
  host.engineVersion = { version: "2.1.100" };
  seedRouterAccount(host, {}, DEFAULT_MODELS);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.proposed, "claude-haiku-4-5-20251001");
  assert.equal(decision?.fallbackReason, "engine-too-old");
});

test("0.6.29 T8, subagent: a spawn on an old engine gets Haiku 4.5's full id, and its row says why", async () => {
  const host = makeFakeHost();
  host.engineVersion = { version: "2.1.292" };
  seedRouterAccount(host, {}, DEFAULT_MODELS);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await spawnThrough(handlers, engine, spawnEvent());
  assert.equal(seen.model, "claude-haiku-4-5-20251001");
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-haiku-4-5-20251001", effort: undefined }));
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.point, "subagent");
  assert.equal(decision?.fallbackReason, "engine-too-old");
});

test("0.6.29 T8: the mod leaves the engine's version where the Agent hook reads it, once per session and without prompt text", async () => {
  const host = makeFakeHost();
  host.engineVersion = { version: "2.1.296", base: "2.1.296" };
  seedRouterAccount(host, {}, DEFAULT_MODELS);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  const written = JSON.parse(host.files.get(ENGINE_VERSION_PATH) ?? "null") as Record<string, unknown> | null;
  assert.equal(written?.version, "2.1.296");
  assert.equal(written?.base, "2.1.296");
  assert.equal(typeof written?.at, "string");
  host.files.set(ENGINE_VERSION_PATH, "marker");
  host.messages = [...host.messages, { role: "assistant", text: "", toolUses: [] }];
  await stepThrough(handlers, engine, turnStepEvent({ ...FRESH_START, index: 1 }));
  assert.equal(host.files.get(ENGINE_VERSION_PATH), "marker", "a later step does not rewrite it");
});

test("router, active: a standard prompt runs on Sonnet at medium effort", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "add a --json flag to the export command", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(seen.model, "claude-sonnet-5-5");
  assert.equal(seen.effort, "medium");
});

test("router, active: a Jev failure changes nothing, and the session keeps its own model afterwards", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  // Nothing queued: the fake fetch rejects, as a network failure would.
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  assert.equal(routerDecisionLines(host)[0]?.reason, "jev-failed");
  const later = turnStepEvent({ ...FRESH_START, index: 1 });
  assert.deepEqual(await stepThrough(handlers, engine, later), later);
});

test("router, active: a guard holds the session's own model on a pointer prompt", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "Read /x/brief.md and do what it says", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.guard, "pointer-prompt");
  assert.equal(decision?.applied, false);
});

test("F9 (hook): a sensitive prompt is only a hint -- its topic flags reach Jev, and a confident simple judgment switches", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "what does the deploy script print?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(seen.model, "claude-haiku-4-5-20251001");
  const state = JSON.parse(host.fetchCalls.at(-1)?.body ?? "{}").state as { topic_flags: string[] };
  assert.deepEqual(state.topic_flags, ["deploy"]);
  assert.equal(routerDecisionLines(host)[0]?.guard, null);
});

test("router: a warm session (assistant messages already, no sticky state) adopts its own model and asks nobody", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [
    { role: "user", text: "hi", toolUses: [] },
    { role: "assistant", text: "hello", toolUses: [] },
    { role: "user", text: "now something else", toolUses: [] },
  ];
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(routerDecisionLines(host).length, 0);
});

test("router, off: nothing at all -- no Jev call, no log, no change", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(routerDecisionLines(host).length, 0);
});

test("router: a subagent's steps are never routed here (point B is agent.spawn)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = turnStepEvent({ ...FRESH_START, agentId: "agent-7" });
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  assert.equal(host.fetchCalls.length, 0);
});

test("router, active: a gateway account routes to its own model ids, never effort", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host, { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" });
  host.messages = [{ role: "user", text: "implement it", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await stepThrough(handlers, engine, turnStepEvent({ index: 0, model: "glm-5.3" }));
  assert.equal(seen.model, "glm-5.2");
  assert.equal("effort" in seen, false);
});

test("router, active: the person switching model mid-session wins -- the router adopts it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  host.messages = [...host.messages, { role: "assistant", text: "hello", toolUses: [] }];
  const manual = turnStepEvent({ index: 1, model: "claude-sonnet-5-5", effort: "medium" });
  assert.deepEqual(await stepThrough(handlers, engine, manual), manual);
});

// ---------------------------------------------------------------------------
// 0.6.16 T1: decision rows join their steps by id; the router's own low is
// never sent on work that may edit.
// ---------------------------------------------------------------------------

test("0.6.16 T1: a main decision row carries the session and turn, and the steps carry the same ids", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "add a --json flag to the export command", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooks(host);
  await stepThrough(handlers, engine, turnStepEvent({ ...FRESH_START, turnId: "turn-7" }));
  const [decision] = routerDecisionLines(host);
  assert.deepEqual([decision?.sessionId, decision?.turnId, decision?.agentId], ["session-1", "turn-7", null]);
  const step = turnUsageLines(host).at(-1);
  assert.deepEqual([step?.sessionId, step?.turnId, step?.index, step?.agentId], ["session-1", "turn-7", 0, null]);
});

test("0.6.16 T1: a subagent decision row carries its agent and its own turn", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooks(host);
  await spawnThrough(handlers, engine, spawnEvent());
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "high" }));
  const [decision] = routerDecisionLines(host);
  assert.deepEqual([decision?.point, decision?.sessionId, decision?.turnId, decision?.agentId], ["subagent", "session-1", "sub-1", "agent-1"]);
  assert.deepEqual([turnUsageLines(host).at(-1)?.agentId, turnUsageLines(host).at(-1)?.turnId], ["agent-1", "sub-1"]);
});

test("0.6.16 T1 (hook, active): simple work held on the session's Opus runs at medium, not the router's old low", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "rename userId to accountId", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple", 0.5));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await stepThrough(handlers, engine, turnStepEvent({ index: 0, model: "claude-opus-5-5", effort: "low" }));
  assert.equal(seen.model, "claude-opus-5-5");
  assert.equal(seen.effort, "medium");
});

// ---------------------------------------------------------------------------
// JEV-060 slice 2, T7: stage switching (point C) -- the first step of every
// later turn may move the sticky model, under hysteresis and break-even.
// ---------------------------------------------------------------------------

const BIG_USAGE = turnStepResult({
  usage: { model: "claude-opus-5-5", input_tokens: 300, output_tokens: 700, cache_read_input_tokens: 79_000, cache_creation_input_tokens: 0 },
});

type Row = { role: "user" | "assistant"; text: string; toolUses: unknown[] };

/** Plays one whole turn: a fresh user prompt, `steps` main-loop steps with a large context, then the assistant's reply in the transcript. Returns the event the turn's FIRST step sent. */
async function playTurn(host: FakeHost, handlers: Map<string, Hook>, engine: unknown, turn: number, prompt: string, steps: number, assistant: Row[] = [{ role: "assistant", text: "ok", toolUses: [] }]): Promise<Record<string, unknown>> {
  host.messages = [...host.messages, { role: "user", text: prompt, toolUses: [] }];
  let first: Record<string, unknown> | null = null;
  for (let index = 0; index < steps; index += 1) {
    const seen = await stepThrough(handlers, engine, turnStepEvent({ turnId: `turn-${turn}`, index, model: "claude-opus-5-5", effort: "high" }), BIG_USAGE);
    if (index === 0) first = seen;
  }
  host.messages = [...host.messages, ...assistant];
  assert.ok(first !== null);
  return first;
}

test("router, active, stage: a downgrade needs the same lower tier on 2 turns and a positive break-even", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  const turn1 = await playTurn(host, handlers, engine, 1, "design the cache invalidation across both services", 4);
  assert.equal(turn1.model, "claude-opus-5-5");
  const turn2 = await playTurn(host, handlers, engine, 2, "thanks, now list the files you touched", 4);
  assert.equal(turn2.model, "claude-opus-5-5", "one lower turn is not enough (hysteresis)");
  assert.equal(host.statusLines.at(-1), "jev · model: Opus 5.5 · high effort · kept: waiting for another such turn (Jev: ask)");
  const turn3 = await playTurn(host, handlers, engine, 3, "and summarise them in one line", 4);
  assert.equal(turn3.model, "claude-haiku-4-5-20251001", "the second lower turn with a positive break-even switches");
  assert.equal(host.statusLines.at(-1), "jev · model: Haiku 4.5", "a switch reads as before");

  const decisions = routerDecisionLines(host);
  assert.deepEqual(decisions.map((row) => row.point), ["start", "stage", "stage"]);
  assert.equal(decisions[1]?.reason, "hysteresis");
  const last = decisions[2];
  assert.equal(last?.reason, "downgrade");
  assert.equal(last?.applied, true);
  assert.equal(last?.contextTokens, 80_000);
  assert.equal(last?.expectedSteps, 12);
  assert.equal(typeof last?.switchCost, "number");
  assert.equal(typeof last?.stepSaving, "number");
});

test("router, active, stage: no downgrade under a guard", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await playTurn(host, handlers, engine, 1, "design the cache invalidation across both services", 4);
  await playTurn(host, handlers, engine, 2, "thanks, now list the files you touched", 4);
  const turn3 = await playTurn(host, handlers, engine, 3, "Read /x/deploy-plan.md and do what it says", 4);
  assert.equal(turn3.model, "claude-opus-5-5");
  assert.equal(routerDecisionLines(host)[2]?.guard, "pointer-prompt");
  assert.equal(host.statusLines.at(-1), "jev · model: Opus 5.5 · high effort · kept: the prompt points to a document (Jev: ask)");
});

test("router, measure, start: a model held by low confidence says why, not just Jev's tier", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple", 0.5));
  const { handlers, engine } = loadHooks(host);
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.reason, "held-by-guard");
  assert.equal(decision?.guard, "low-confidence");
  assert.equal(host.statusLines.at(-1), "jev · would use: Opus 5.5 · high effort · would keep: low confidence (Jev: ask)");
});

test("router, active, stage: an unsure turn after a failure on the weaker model restores the session's own (F9: low confidence is the guard)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple", 0.5));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const turn1 = await playTurn(host, handlers, engine, 1, "run the tests", 2, [
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "t1", tool: "Bash", input: { command: "npm test" }, text: "✖ 3 failing", isError: true }] },
    { role: "assistant", text: "they fail", toolUses: [] },
  ]);
  assert.equal(turn1.model, "claude-haiku-4-5-20251001");
  const turn2 = await playTurn(host, handlers, engine, 2, "fix them", 1);
  assert.equal(turn2.model, "claude-opus-5-5");
  assert.equal(turn2.effort, "high");
  const stage = routerDecisionLines(host)[1];
  assert.equal(stage?.reason, "floor-restore");
  assert.equal(stage?.guard, "low-confidence");
});

test("router, measure, stage: logs stage decisions and changes nothing", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  for (const [turn, prompt] of [[1, "design it"], [2, "list files"], [3, "summarise"]] as const) {
    const first = await playTurn(host, handlers, engine, turn, prompt, 4);
    assert.equal(first.model, "claude-opus-5-5");
    assert.equal(first.effort, "high");
  }
  const decisions = routerDecisionLines(host);
  assert.equal(decisions.length, 3);
  assert.equal(decisions[2]?.reason, "downgrade");
  assert.equal(decisions[2]?.applied, false);
});

// ---------------------------------------------------------------------------
// Track R (odd/tasks/router-cold-switch.md): after a gap longer than the
// cache TTL the switch's rewrite happens anyway, so break-even charges none.
// ---------------------------------------------------------------------------

const TRANSCRIPT = "/home/dev/.claude/projects/sandbox/session-1.jsonl";

function transcriptRow(bucket: "1h" | "5m"): string {
  const creation = bucket === "1h" ? { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 900 };
  return JSON.stringify({ type: "assistant", isSidechain: false, timestamp: "2026-09-25T10:00:00.000Z", message: { role: "assistant", usage: { input_tokens: 3, output_tokens: 10, cache_creation: creation } } });
}

async function fireStop(handlers: Map<string, Hook>, engine: unknown): Promise<unknown> {
  const stop = handlers.get("classic.Stop");
  assert.ok(stop, "classic.Stop was never registered");
  return stop(engine, { hook_event_name: "Stop", session_id: "session-1", transcript_path: TRANSCRIPT, cwd: CWD, stop_hook_active: false }, async (e: unknown) => ({ passed: e }));
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && key in value;
}

/** Two one-step turns (complex, then a first simple one), the Stop hook reading `bucket`, a gap of `gapMs`, then a second simple turn. Returns the third turn's first step. */
async function coldGapTurns(host: FakeHost, options: Record<string, unknown>, bucket: "1h" | "5m" | null, gapMs: number): Promise<Record<string, unknown>> {
  seedRouterAccount(host);
  if (bucket !== null) host.transcripts.set(TRANSCRIPT, `${transcriptRow(bucket)}\n`);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, options);
  await playTurn(host, handlers, engine, 1, "design the cache invalidation across both services", 1);
  await playTurn(host, handlers, engine, 2, "thanks, now list the files you touched", 1);
  if (bucket !== null) await fireStop(handlers, engine);
  host.clockOffsetMs += gapMs;
  return playTurn(host, handlers, engine, 3, "and summarise them in one line", 1);
}

test("R2: the mod loads with its cache_warmth import, and classic.Stop reads the TTL from the transcript tail into $.state", async () => {
  const host = makeFakeHost();
  host.transcripts.set(TRANSCRIPT, `${transcriptRow("5m")}\n`);
  const { handlers, engine } = loadHooks(host);
  const result = await fireStop(handlers, engine);
  assert.ok(hasKey(result, "passed"), "Stop goes on to the next hook unchanged");
  assert.ok(host.processCalls.includes(`tail -n 300 ${TRANSCRIPT}`));
  assert.deepEqual(host.state.get("routerCache"), { ttlMs: 5 * 60_000, lastMainAt: Date.parse("2026-09-25T10:00:00.000Z") });
});

test("R2: a Stop the transcript cannot answer, or the router off, leaves the cache unknown and the Stop unchanged", async () => {
  const host = makeFakeHost();
  host.failProcess = true;
  const { handlers, engine } = loadHooks(host);
  assert.ok(hasKey(await fireStop(handlers, engine), "passed"));
  assert.equal(host.state.has("routerCache"), false);
  const off = makeFakeHost();
  off.transcripts.set(TRANSCRIPT, `${transcriptRow("5m")}\n`);
  const loaded = loadHooksWith(off, { routerMode: "off" });
  assert.ok(hasKey(await fireStop(loaded.handlers, loaded.engine), "passed"));
  assert.equal(off.processCalls.length, 0, "off reads nothing");
});

test("R2 measure: after a gap past the TTL a held downgrade logs wouldApplyCold, and the step is sent unchanged", async () => {
  const host = makeFakeHost();
  const turn3 = await coldGapTurns(host, {}, "5m", 6 * 60_000);
  assert.equal(turn3.model, "claude-opus-5-5");
  assert.equal(turn3.effort, "high");
  const last = routerDecisionLines(host).at(-1);
  assert.equal(last?.reason, "downgrade");
  assert.equal(last?.applied, false);
  assert.equal(last?.cacheWarm, false);
  assert.equal(last?.switchCost, 0);
  assert.equal(last?.wouldApplyCold, true);
  assert.equal(hasKey(last, "appliedCold"), false);
});

test("R2 active: after a gap past the TTL the held downgrade applies and logs appliedCold", async () => {
  const host = makeFakeHost();
  const turn3 = await coldGapTurns(host, { routerMode: "active" }, "5m", 6 * 60_000);
  assert.equal(turn3.model, "claude-haiku-4-5-20251001");
  const last = routerDecisionLines(host).at(-1);
  assert.equal(last?.reason, "downgrade");
  assert.equal(last?.applied, true);
  assert.equal(last?.appliedCold, true);
});

test("R2: a warm cache, or one never read, holds the downgrade as before", async () => {
  for (const [bucket, warm] of [["1h", true], [null, null]] as const) {
    const host = makeFakeHost();
    const turn3 = await coldGapTurns(host, { routerMode: "active" }, bucket, 6 * 60_000);
    assert.equal(turn3.model, "claude-opus-5-5");
    const last = routerDecisionLines(host).at(-1);
    assert.equal(last?.reason, "break-even");
    assert.equal(last?.cacheWarm, warm);
    assert.equal(hasKey(last, "wouldApplyCold") || hasKey(last, "appliedCold"), false);
  }
});

test("R2: each main step stamps the last main request time; a subagent step does not", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("complex"));
  const { handlers, engine } = loadHooks(host);
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  const stamped = host.state.get("routerCache");
  assert.ok(hasKey(stamped, "lastMainAt"));
  host.clockOffsetMs += 60_000;
  await stepThrough(handlers, engine, turnStepEvent({ ...FRESH_START, agentId: "agent-9", index: 0 }));
  assert.deepEqual(host.state.get("routerCache"), stamped);
});

// ---------------------------------------------------------------------------
// R5 (odd/tasks/router-cache-ttl.md): on Team/Enterprise accounts the
// built-in security plugin withholds `classic.*` events, so `classic.Stop`
// never reads the TTL. The router reads the transcript tail itself.
// ---------------------------------------------------------------------------

/** Where Claude Code keeps this fake session's transcript: `<CLAUDE_CONFIG_DIR>/projects/<slug of CWD>/session-1.jsonl`. */
const OWN_TRANSCRIPT = `${ACCOUNT_DIR}/projects/-home-dev-Projects-sandbox/session-1.jsonl`;

/** Three one-step turns (complex, simple, simple) with no Stop at all, and a gap of `gapMs` before the third. `withConfigDir` false leaves CLAUDE_CONFIG_DIR unset (`~/.claude`). Returns the stage rows. */
async function stoplessTurns(host: FakeHost, gapMs: number, withConfigDir = true): Promise<Record<string, unknown>[]> {
  seedRouterAccount(host);
  if (!withConfigDir) host.env.delete("CLAUDE_CONFIG_DIR");
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  await playTurn(host, handlers, engine, 1, "design the cache invalidation across both services", 1);
  await playTurn(host, handlers, engine, 2, "thanks, now list the files you touched", 1);
  host.clockOffsetMs += gapMs;
  await playTurn(host, handlers, engine, 3, "and summarise them in one line", 1);
  return routerDecisionLines(host).filter((row) => row.point === "stage");
}

test("R5: with classic.Stop never fired, the router reads the TTL from the session's own transcript, so both stage rows know the cache", async () => {
  const host = makeFakeHost();
  host.transcripts.set(OWN_TRANSCRIPT, `${transcriptRow("5m")}\n`);
  const stages = await stoplessTurns(host, 6 * 60_000);
  assert.deepEqual(stages.map((row) => row.cacheWarm), [true, false]);
  assert.ok(host.processCalls.includes(`tail -n 300 ${OWN_TRANSCRIPT}`));
  assert.equal((host.state.get("routerCache") as { ttlMs: unknown }).ttlMs, 5 * 60_000);
  assert.equal(host.processCalls.filter((call) => call.startsWith("tail ")).length, 1, "read once: the clock is known after it");
});

test("R5: without CLAUDE_CONFIG_DIR the config dir is ~/.claude, and a transcript elsewhere under its projects is found by session id", async () => {
  const host = makeFakeHost();
  const moved = "/home/dev/.claude/projects/-home-dev-Projects-old-place/session-1.jsonl";
  host.transcripts.set(moved, `${transcriptRow("1h")}\n`);
  host.processHandler = (argv) => (argv[0] === "find" ? { exitCode: 0, stdout: `${moved}\n`, stderr: "" } : undefined);
  const stages = await stoplessTurns(host, 6 * 60_000, false);
  assert.deepEqual(stages.map((row) => row.cacheWarm), [true, true]);
  assert.ok(host.processCalls.includes("tail -n 300 /home/dev/.claude/projects/-home-dev-Projects-sandbox/session-1.jsonl"), "the session's own path first");
  assert.ok(host.processCalls.includes("find -H /home/dev/.claude/projects -maxdepth 2 -type f -name session-1.jsonl"));
  assert.ok(host.processCalls.includes(`tail -n 300 ${moved}`));
});

test("R5: a transcript that cannot be read leaves the cache unknown and the turn routed as before", async () => {
  const host = makeFakeHost();
  host.processHandler = (argv) => {
    if (argv[0] === "find") throw new Error("fake host: find cannot start");
    return undefined;
  };
  const stages = await stoplessTurns(host, 6 * 60_000);
  assert.deepEqual(stages.map((row) => row.cacheWarm), [null, null]);
  assert.deepEqual(stages.map((row) => row.cacheUnknown), ["tail-failed", "tail-failed"]);
  assert.deepEqual(stages.map((row) => row.reason), ["hysteresis", "break-even"]);
});

test("R6: a transcript with no cache write says no-ttl; a known cache carries no cacheUnknown", async () => {
  const host = makeFakeHost();
  host.transcripts.set(OWN_TRANSCRIPT, `${JSON.stringify({ type: "user", timestamp: "2026-09-25T10:00:00.000Z" })}\n`);
  const stages = await stoplessTurns(host, 6 * 60_000);
  assert.deepEqual(stages.map((row) => [row.cacheWarm, row.cacheUnknown]), [[null, "no-ttl"], [null, "no-ttl"]]);
  const known = makeFakeHost();
  known.transcripts.set(OWN_TRANSCRIPT, `${transcriptRow("5m")}\n`);
  for (const row of await stoplessTurns(known, 6 * 60_000)) assert.equal(hasKey(row, "cacheUnknown"), false);
});

test("R7: an applied upgrade logs the rewrite it paid, and a known cold cache makes it 0 without holding the upgrade", async () => {
  for (const [gapMs, cost] of [[60_000, 0.64], [6 * 60_000, 0]] as const) {
    const host = makeFakeHost();
    seedRouterAccount(host);
    host.transcripts.set(OWN_TRANSCRIPT, `${transcriptRow("5m")}\n`);
    host.fetchQueue.push(tierAnswer("simple"), tierAnswer("complex"));
    const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
    const turn1 = await playTurn(host, handlers, engine, 1, "rename userId to accountId", 1);
    assert.equal(turn1.model, "claude-haiku-4-5-20251001");
    host.clockOffsetMs += gapMs;
    const turn2 = await playTurn(host, handlers, engine, 2, "design the cache invalidation across both services", 1);
    assert.equal(turn2.model, "claude-opus-5-5", "an upgrade never waits");
    const stage = routerDecisionLines(host).at(-1);
    assert.equal(stage?.reason, "upgrade");
    assert.equal(stage?.applied, true);
    assert.equal(stage?.cacheWarm, gapMs < 5 * 60_000);
    assert.ok(Math.abs((stage?.switchCost as number) - cost) < 1e-9, `switchCost ${String(stage?.switchCost)}`);
    assert.equal(stage?.stepSaving, null, "a quality switch has no saving");
  }
});

test("G8: a Jev answer of 402 (no credit) names the router rows jev-payment, at start and at a stage, instead of jev-failed", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(httpFailure(402), httpFailure(402));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const turn1 = await playTurn(host, handlers, engine, 1, "design the cache invalidation across both services", 1);
  const turn2 = await playTurn(host, handlers, engine, 2, "thanks, now list the files you touched", 1);
  assert.deepEqual([turn1.model, turn2.model], ["claude-opus-5-5", "claude-opus-5-5"], "nothing changes, as with any Jev failure");
  assert.deepEqual(routerDecisionLines(host).map((row) => [row.point, row.reason]), [["start", "jev-payment"], ["stage", "jev-payment"]]);
  const other = makeFakeHost();
  seedRouterAccount(other);
  other.fetchQueue.push(httpFailure(401));
  const loaded = loadHooks(other);
  await playTurn(other, loaded.handlers, loaded.engine, 1, "design it", 1);
  assert.equal(routerDecisionLines(other)[0]?.reason, "jev-failed", "any other failure stays jev-failed");
});

// ---------------------------------------------------------------------------
// JEV-060 slice 2, T8: subagent routing (point B) on agent.spawn.
// ---------------------------------------------------------------------------

function spawnEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool_use_id: "toolu_1",
    prompt: "List every file under src/ and summarise what each one does in one line.",
    description: "List files",
    subagentType: "general-purpose",
    provider: { plugin: "engine", tier: "core" },
    parentModel: "claude-opus-5-5",
    background: false,
    fork: false,
    ...overrides,
  };
}

async function spawnThrough(handlers: Map<string, Hook>, engine: unknown, event: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hook = handlers.get("agent.spawn");
  assert.ok(hook, "agent.spawn was never registered");
  let seen: Record<string, unknown> | null = null;
  await hook(engine, event, async (e: unknown) => {
    seen = e as Record<string, unknown>;
    return { model: String((e as { model?: string }).model ?? "inherit"), agentId: "agent-1" };
  });
  assert.ok(seen !== null, "next was never called");
  return seen;
}

test("router, active, subagent: no explicit model -- the tier's full id", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await spawnThrough(handlers, engine, spawnEvent());
  assert.equal(seen.model, "claude-haiku-4-5-20251001");
  // 0.6.3: the point='subagent' decision line is written on the subagent's
  // first turn.step, not at spawn (its effort must match what that step sends).
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-haiku-4-5-20251001", effort: undefined }));
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.point, "subagent");
  assert.equal(decision?.applied, true);
  assert.equal(JSON.stringify(decision).includes("summarise"), false, "no prompt text in the log");
});

test("G8: a subagent judged into a 402 logs jev-payment and spawns as it came", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(httpFailure(402));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = spawnEvent();
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: undefined }));
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.point, "subagent");
  assert.equal(decision?.reason, "jev-payment");
  assert.equal(decision?.applied, false);
});

test("router, measure, subagent: logs, changes nothing", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  const event = spawnEvent();
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: undefined }));
  assert.equal(routerDecisionLines(host)[0]?.applied, false);
});

test("router, active, subagent: an explicit model is never downgraded when the person keeps them", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = spawnEvent({ model: "sonnet" });
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
});

test("router, active, subagent: guards hold the parent's model", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = spawnEvent({ prompt: "Read /x/brief.md and do what it says" });
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: undefined }));
  assert.equal(routerDecisionLines(host)[0]?.guard, "pointer-prompt");
});

test("router, subagent: a fork, off mode, or a Jev failure change nothing", async () => {
  for (const [options, event, queued] of [
    [{ routerMode: "active" }, spawnEvent({ fork: true }), true],
    [{ routerMode: "off" }, spawnEvent(), true],
    [{ routerMode: "active" }, spawnEvent(), false],
  ] as const) {
    const host = makeFakeHost();
    seedRouterAccount(host);
    if (queued) host.fetchQueue.push(tierAnswer("simple"));
    const { handlers, engine } = loadHooksWith(host, options);
    assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  }
});

// ---------------------------------------------------------------------------
// JEV-061 slice 2: a subagent's own first-step effort. A cold context makes
// its FIRST step, like its model, free to set -- but it used to inherit the
// parent's own effort, clamped to what its model supports, never the tier's
// own (a standard-work subagent on Sonnet ran every step at the parent's
// `xhigh`, clamped to `high`, never `medium`). `agent.spawn`'s fake `next`
// (spawnThrough, above) always hands back `agentId: "agent-1"`, which
// `turn.step` events below name the same way.
// ---------------------------------------------------------------------------

test("JEV-061 slice 2: a subagent routed to Sonnet for standard work gets medium on its first step and keeps it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent());

  const first = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "xhigh" }));
  assert.equal(first.effort, "medium");

  const second = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 1, model: "claude-sonnet-5-5", effort: "xhigh" }));
  assert.equal(second.effort, "medium", "kept sticky on a later step of the same agent");
});

test("JEV-061 slice 2: an explicit parent model leaves the subagent's effort untouched", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent({ model: "sonnet" }));

  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh");
});

test("JEV-061 slice 2: a guard at spawn leaves the subagent's effort untouched", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent({ prompt: "Read /x/brief.md and do what it says" }));

  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh", "a guard never lets the effort fall");
});

test("JEV-061 slice 2, 0.6.3 F0: an unguarded subagent's effort is raised when the chosen tier asks for more", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent({ parentModel: "claude-sonnet-5-5" }));

  // complex -> high, and this step only carries "low" -- unguarded, the tier's effort wins.
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "low" }));
  assert.equal(step.effort, "high");
  // JEVADV-63 R1: the logged point='subagent' effort matches what this step actually sent -- not the raw spawn-time target.
  assert.equal(routerDecisionLines(host).at(-1)?.effort, "high");
});

test("JEV-061 slice 2: measure mode changes nothing", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooks(host);
  await spawnThrough(handlers, engine, spawnEvent());

  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh");
});

// ---------------------------------------------------------------------------
// Review round 2: findings 1, 2, 3, 4 and 12 at the hook
// ---------------------------------------------------------------------------

const OPUS_XHIGH = { model: "claude-opus-5-5", effort: "xhigh" };

/** One turn with a new real prompt, one step, the given effort; returns what the step sent. */
async function promptTurn(host: FakeHost, handlers: Map<string, Hook>, engine: unknown, turn: number, prompt: string, session: Record<string, unknown>, assistant: Row[] = [{ role: "assistant", text: "ok", toolUses: [] }]): Promise<Record<string, unknown>> {
  host.messages = [...host.messages, { role: "user", text: prompt, toolUses: [] }];
  const seen = await stepThrough(handlers, engine, turnStepEvent({ turnId: `turn-${turn}`, index: 0, ...session }));
  host.messages = [...host.messages, ...assistant];
  return seen;
}

const FAILED_TESTS: Row[] = [
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "t1", tool: "Bash", input: { command: "npm test" }, text: "✖ 2 failing", isError: true }] },
  { role: "assistant", text: "they fail", toolUses: [] },
];

test("finding 1 (hook): a Jev failure on a sensitive turn below the floor sends the session's own model", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH, FAILED_TESTS);
  assert.equal(first.model, "claude-haiku-4-5-20251001");
  // Nothing queued: Jev fails.
  const second = await promptTurn(host, handlers, engine, 2, "deploy the migration to production", OPUS_XHIGH);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.effort, "xhigh");
});

test("finding 2 (hook): a floor-restore sends the session's max effort, not none", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  // F9: the failure is a fact for Jev; an unsure second judgment is the guard.
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple", 0.5));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const session = { model: "claude-opus-5-5", effort: "max" };
  await promptTurn(host, handlers, engine, 1, "hola", session, FAILED_TESTS);
  const second = await promptTurn(host, handlers, engine, 2, "fix them", session);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.effort, "max");
});

test("finding 3: after the mode goes from active to measure, no step is rewritten any more", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
  const active = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, active.handlers, active.engine, 1, "hola", OPUS_XHIGH);
  assert.equal(first.model, "claude-haiku-4-5-20251001");
  // The person picks measure: the module reloads, $.state survives.
  const measure = loadHooksWith(host, { routerMode: "measure" });
  const later = turnStepEvent({ turnId: "turn-1", index: 1, ...OPUS_XHIGH });
  assert.deepEqual(await stepThrough(measure.handlers, measure.engine, later), later);
  const second = await promptTurn(host, measure.handlers, measure.engine, 2, "thanks", OPUS_XHIGH);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.effort, "xhigh");
});

test("finding 4: an engine-started turn (no new prompt) neither asks Jev nor counts toward hysteresis", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await playTurn(host, handlers, engine, 1, "design the cache invalidation across both services", 4);
  await playTurn(host, handlers, engine, 2, "list the files you touched", 4);
  const callsBefore = host.fetchCalls.length;
  // The engine starts turn 3 by itself (a subagent finished): same last prompt.
  const engineTurn = await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-3", index: 0, model: "claude-opus-5-5", effort: "high" }), BIG_USAGE);
  assert.equal(host.fetchCalls.length, callsBefore, "no Jev call for an engine-started turn");
  assert.equal(engineTurn.model, "claude-opus-5-5");
  assert.equal(routerDecisionLines(host).length, 2, "no stage decision logged for it");
});

test("finding 12: a routing error on a later step keeps the sticky model instead of flipping to the session's", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH);
  host.failMessages = true;
  host.messages = [...host.messages, { role: "user", text: "and now?", toolUses: [] }];
  const second = await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-2", index: 0, ...OPUS_XHIGH }));
  assert.equal(second.model, "claude-haiku-4-5-20251001");
});

// ---------------------------------------------------------------------------
// Gap G6, overridden by 0.6.2 F11 (owner decision): client protection is
// the Bash gate's. A client site or a scoped policy no longer holds the
// router's floor; the destination kind is a fact in Jev's state.
// ---------------------------------------------------------------------------

function seedCatalog(host: FakeHost, kind: string, policies: unknown[] = []): void {
  host.files.set(`${CONFIG_DIR}/catalog.json`, JSON.stringify({ destinations: [{ id: "here", label: "Here", kind, worktreePath: CWD, autonomy: {} }] }));
  host.files.set(`${CONFIG_DIR}/policies.json`, JSON.stringify(policies));
}

test("F11, point A: a client site no longer holds the floor -- a simple prompt there is routed down, and Jev sees the destination", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedCatalog(host, "client-site");
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH);
  assert.equal(seen.model, "claude-haiku-4-5-20251001");
  assert.equal(routerDecisionLines(host)[0]?.guard, null);
  assert.equal(JSON.parse(host.fetchCalls.at(-1)?.body ?? "{}").state.destination_kind, "client-site");
});

test("F11, point A: a scoped prohibits policy no longer holds the floor either", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedCatalog(host, "project", [{ id: "freeze", rule: "no changes this week", kind: "prohibits", destinations: ["here"] }]);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  assert.equal((await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH)).model, "claude-haiku-4-5-20251001");
  assert.equal(routerDecisionLines(host)[0]?.guard, null);
});

test("F11, point B: a subagent spawned in a client site is routed like any other", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedCatalog(host, "client-site");
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await spawnThrough(handlers, engine, spawnEvent());
  assert.equal(seen.model, "claude-haiku-4-5-20251001");
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-haiku-4-5-20251001", effort: undefined }));
  assert.equal(routerDecisionLines(host)[0]?.guard, null);
});

test("F11, point C: a cwd that resolves to a client site does not restore the floor by itself", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  assert.equal((await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH)).model, "claude-haiku-4-5-20251001");
  seedCatalog(host, "client-site");
  const second = await promptTurn(host, handlers, engine, 2, "thanks", OPUS_XHIGH);
  assert.equal(second.model, "claude-haiku-4-5-20251001");
  assert.equal(routerDecisionLines(host)[1]?.guard, null);
});

test("G6: a missing catalog is unknown and keeps today's behaviour", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  assert.equal((await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH)).model, "claude-haiku-4-5-20251001");
});

test("G6: a lookup error (unreadable catalog, failing git) is unknown and keeps today's behaviour", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/catalog.json`, "{ not json");
  host.failProcess = true;
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  assert.equal((await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH)).model, "claude-haiku-4-5-20251001");
});

// ---------------------------------------------------------------------------
// Round 3: N1, N2 and N3 at the hook
// ---------------------------------------------------------------------------

/** One whole turn on the given session model/effort: a new real prompt, `steps` main steps with a large context, then `assistant` in the transcript. Returns the first step's event. */
async function playTurnAs(host: FakeHost, handlers: Map<string, Hook>, engine: unknown, turn: number, prompt: string, steps: number, session: Record<string, unknown>, assistant: Row[] = [{ role: "assistant", text: "ok", toolUses: [] }]): Promise<Record<string, unknown>> {
  host.messages = [...host.messages, { role: "user", text: prompt, toolUses: [] }];
  let first: Record<string, unknown> | null = null;
  for (let index = 0; index < steps; index += 1) {
    const seen = await stepThrough(handlers, engine, turnStepEvent({ turnId: `turn-${turn}`, index, ...session }), BIG_USAGE);
    if (index === 0) first = seen;
  }
  host.messages = [...host.messages, ...assistant];
  assert.ok(first !== null);
  return first;
}

test("N1 (hook): a downgrade back to the session's own [1m] model sends the session's own step, unrewritten", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const session = { model: "claude-haiku-4-5-20251001[1m]" };
  const own = { ...session };
  const up = await playTurnAs(host, handlers, engine, 1, "design the sync protocol", 4, own);
  assert.equal(up.model, "claude-opus-5-5");
  await playTurnAs(host, handlers, engine, 2, "list the files", 4, own);
  const back = await playTurnAs(host, handlers, engine, 3, "summarise them", 4, own);
  assert.equal(routerDecisionLines(host)[2]?.reason, "downgrade");
  assert.equal(back.model, "claude-haiku-4-5-20251001[1m]");
  assert.equal(back.effort, "high", "the session's own effort, as its own step carried it");
  const later = turnStepEvent({ turnId: "turn-3", index: 1, ...own });
  assert.deepEqual(await stepThrough(handlers, engine, later), later, "no rewrite on the session's own model");
});

test("N2 / F9: an engine-started turn after a failing test asks Jev nothing and keeps the sticky model; Jev sees the failure at the next person prompt", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, "run the tests in the background", OPUS_XHIGH, FAILED_TESTS);
  assert.equal(first.model, "claude-haiku-4-5-20251001");
  const calls = host.fetchCalls.length;
  // A subagent finished: the engine starts turn 2 by itself, no new prompt.
  const engineTurn = await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-2", index: 0, ...OPUS_XHIGH }));
  assert.equal(engineTurn.model, "claude-haiku-4-5-20251001");
  assert.equal(host.fetchCalls.length, calls, "no Jev call on an engine-started turn");
  assert.equal(routerDecisionLines(host).length, 1, "only point A was decided");
  const next = await promptTurn(host, handlers, engine, 3, "fix them", OPUS_XHIGH);
  const state = JSON.parse(host.fetchCalls.at(-1)?.body ?? "{}").state as { previous_turn: { failed: boolean } };
  assert.equal(state.previous_turn.failed, true, "the failure reaches Jev as a fact");
  assert.equal(next.model, "claude-opus-5-5", "Jev weighed it and chose the stronger model");
});

test("N2: an engine-started turn with clean work keeps the sticky choice", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH);
  const engineTurn = await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-2", index: 0, ...OPUS_XHIGH }));
  assert.equal(engineTurn.model, "claude-haiku-4-5-20251001");
  assert.equal(routerDecisionLines(host).length, 1);
});

test("N3: a new prompt after /compact is seen even when the real-prompt count is back to the stored one", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"), tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH);
  await promptTurn(host, handlers, engine, 2, "sigue", OPUS_XHIGH);
  // /compact: the transcript becomes a summary, then the person types a new prompt.
  host.messages = [
    { role: "user", text: "This session is being continued from a previous conversation. Summary: greetings.", toolUses: [] },
    { role: "assistant", text: "ok", toolUses: [] },
  ];
  const calls = host.fetchCalls.length;
  const next = await promptTurn(host, handlers, engine, 3, "diseña la sincronización offline de la app", OPUS_XHIGH);
  assert.equal(host.fetchCalls.length, calls + 1, "the new prompt got its stage decision");
  assert.equal(next.model, "claude-opus-5-5");
});

test("N3: the same prompt after /compact is not a new prompt (no second decision for it)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH);
  host.messages = [{ role: "user", text: "hola", toolUses: [] }];
  const calls = host.fetchCalls.length;
  await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-2", index: 0, ...OPUS_XHIGH }));
  assert.equal(host.fetchCalls.length, calls);
});

// ---------------------------------------------------------------------------
// JEV-061: the router's own personhood gate (point A/C). `$.session.messages()`
// rows carry no origin, so a background task's notification used to read as
// a brand-new real prompt and run a full stage decision -- counting toward
// the downgrade hysteresis exactly like a person's own prompt. `prompt.submit`
// now stamps `e.origin.kind` into the router's own `$.state` on every
// submission; a turn whose latest prompt is not a person's own is routed
// exactly like an engine-started turn (N2): no Jev call, no hysteresis count.
// ---------------------------------------------------------------------------

test("JEV-061: two task notifications after a person prompt cause no Jev call and no downgrade -- the next person prompt is still judged", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  host.fetchQueue.push(tierAnswer("complex"));
  await submitOrigin(handlers, engine, "composer");
  const turn1 = await promptTurn(host, handlers, engine, 1, "design the cache invalidation across both services", OPUS_XHIGH);
  assert.equal(turn1.model, "claude-opus-5-5");

  const callsBefore = host.fetchCalls.length;
  const decisionsBefore = routerDecisionLines(host).length;

  await submitOrigin(handlers, engine, "task-notification");
  const note1 = await promptTurn(host, handlers, engine, 2, "Task finished: the build succeeded.", OPUS_XHIGH);
  assert.equal(note1.model, "claude-opus-5-5", "a notification must never rewrite the sticky model");

  await submitOrigin(handlers, engine, "task-notification");
  const note2 = await promptTurn(host, handlers, engine, 3, "Task finished: tests are green.", OPUS_XHIGH);
  assert.equal(note2.model, "claude-opus-5-5");

  assert.equal(host.fetchCalls.length, callsBefore, "no Jev call for either notification");
  assert.equal(routerDecisionLines(host).length, decisionsBefore, "no stage decision logged for either notification -- none counted toward hysteresis");

  host.fetchQueue.push(tierAnswer("simple"));
  await submitOrigin(handlers, engine, "composer");
  await promptTurn(host, handlers, engine, 4, "thanks, now list the files you touched", OPUS_XHIGH);
  assert.equal(host.fetchCalls.length, callsBefore + 1, "the next person prompt gets its own stage decision");
  const decisions = routerDecisionLines(host);
  assert.equal(decisions.at(-1)?.point, "stage");
});

test("JEV-061 / F9: a notification after a failing test asks Jev nothing and, the failure being only a fact now, keeps the sticky model", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  await submitOrigin(handlers, engine, "composer");
  const first = await promptTurn(host, handlers, engine, 1, "run the tests in the background", OPUS_XHIGH, FAILED_TESTS);
  assert.equal(first.model, "claude-haiku-4-5-20251001");

  const calls = host.fetchCalls.length;
  await submitOrigin(handlers, engine, "task-notification");
  // Different text from the person's own prompt -- would read as a brand
  // new real prompt if `$.session.messages()` were the only signal.
  const decisionsBefore = routerDecisionLines(host).length;
  const note = await promptTurn(host, handlers, engine, 2, "Task finished: the background tests are still failing.", OPUS_XHIGH);
  assert.equal(note.model, "claude-haiku-4-5-20251001", "no hard guard holds: the sticky model stays");
  assert.equal(host.fetchCalls.length, calls, "no Jev call for the notification");
  assert.equal(routerDecisionLines(host).length, decisionsBefore, "nothing decided");
});

test("JEV-061, point A: a first prompt that is a notification keeps the session's own model -- the router decides at the first person prompt", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedSamplingConfig(host, { enabled: false, sampleRate: 0, dailyPromptCap: 0 });
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  await submitOrigin(handlers, engine, "task-notification");
  host.messages = [{ role: "user", text: "Task finished: the setup script ran.", toolUses: [] }];
  const first = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(first.model, "claude-opus-5-5", "the session's own model, unrouted");
  assert.equal(host.fetchCalls.length, 0, "no Jev call for the very first, non-person prompt");
  assert.equal(routerDecisionLines(host).length, 0, "nothing decided yet");

  host.messages = [...host.messages, { role: "assistant", text: "ok", toolUses: [] }, { role: "user", text: "hola", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  await submitOrigin(handlers, engine, "composer");
  await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-2", index: 0, model: "claude-opus-5-5", effort: "high" }));
  assert.equal(host.fetchCalls.length, 1, "the first person prompt is what gets judged");
  const decisions = routerDecisionLines(host);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.point, "stage");
  assert.equal(decisions[0]?.tier, "simple");
});

test("JEV-061: prompt.submit passes the event through unchanged, origin included -- it never alters or blocks the prompt", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const submit = handlers.get("prompt.submit");
  assert.ok(submit, "prompt.submit was never registered");
  const event = { text: "Task finished: the build succeeded.", wait: false, origin: { kind: "task-notification" } };
  let seen: unknown;
  await submit(engine, event, async (e: unknown) => {
    seen = e;
    return e;
  });
  assert.deepEqual(seen, event);
});

test("JEV-061: if prompt.submit never fired for a turn (state lost to a hot reload), today's behaviour is kept -- a new prompt is still judged", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  // Router tests above this one already exercise this path with no
  // `prompt.submit` ever fired (state.get returns undefined for
  // `routerPromptOrigin`); this test names that behaviour explicitly.
  await playTurn(host, handlers, engine, 1, "design the cache invalidation across both services", 4);
  const turn2 = await playTurn(host, handlers, engine, 2, "now something completely different", 4);
  assert.equal(host.fetchCalls.length, 2, "both turns were judged -- no stamped origin defaults to a person's own prompt");
  void turn2;
});

// ---------------------------------------------------------------------------
// 0.6.2: effort by need. The owner's account runs Opus at a sticky xhigh
// (modelSettings effortLevel); every main step since 0.6.1 stayed there.
// ---------------------------------------------------------------------------

/** 20 main Opus steps per effort in an earlier hour's turn-usage file: the medians the lowering break-even reads. */
function seedEffortUsage(host: FakeHost, outputs: Record<string, number>): void {
  const lines: string[] = [];
  for (const [effort, output] of Object.entries(outputs)) {
    for (let i = 0; i < 20; i += 1) lines.push(JSON.stringify({ at: "2026-09-24T10:00:00.000Z", agent: "main", model: "claude-opus-5-5", effort, input: 10, output, cacheRead: 0, cacheWrite: 0, stopReason: "end_turn", account: "acct-1" }));
  }
  host.files.set(`${CACHE_DIR}/turn-usage-2026-09-24T10.jsonl`, `${lines.join("\n")}\n`);
}

test("0.6.2 E1 (hook): back up to the session's own Opus for complex work runs at high, not the account's sticky xhigh", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH);
  assert.equal(first.model, "claude-haiku-4-5-20251001");
  const second = await promptTurn(host, handlers, engine, 2, "why does checkout double-charge sometimes?", OPUS_XHIGH);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.effort, "high");
  const upgrade = routerDecisionLines(host).at(-1);
  assert.equal(upgrade?.reason, "upgrade");
  assert.equal(upgrade?.effort, "high");
});

test("0.6.2 E2 (hook, active): frontier work on the same Opus raises the effort at once and logs it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("frontier", 0.8));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, "why does checkout double-charge sometimes?", OPUS_XHIGH);
  assert.equal(first.effort, "high");
  const second = await promptTurn(host, handlers, engine, 2, "prove this algorithm terminates", OPUS_XHIGH);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.effort, "xhigh");
  const raise = routerDecisionLines(host).at(-1);
  assert.equal(raise?.point, "stage");
  assert.equal(raise?.reason, "effort-raise");
  assert.equal(raise?.effort, "xhigh");
  assert.equal(raise?.applied, true);
  assert.equal("text" in (raise ?? {}), false);
});

test("0.6.2 E2 (hook, measure): a raise is logged but never sent", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("frontier", 0.9));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "measure" });
  const session = { model: "claude-opus-5-5", effort: "high" };
  await promptTurn(host, handlers, engine, 1, "why does checkout double-charge sometimes?", session);
  const second = await promptTurn(host, handlers, engine, 2, "prove this algorithm terminates", session);
  assert.equal(second.effort, "high");
  const raise = routerDecisionLines(host).at(-1);
  assert.equal(raise?.reason, "effort-raise");
  assert.equal(raise?.applied, false);
});

test("0.6.2 E2 (hook, active): xhigh comes down to high after 2 complex prompts, when the account's real medians pay for the rewrite", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedEffortUsage(host, { xhigh: 6000, high: 2000 });
  host.fetchQueue.push(tierAnswer("frontier"), tierAnswer("complex"), tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, "prove this algorithm terminates", OPUS_XHIGH);
  assert.equal(first.effort, "xhigh");
  const second = await promptTurn(host, handlers, engine, 2, "why does checkout double-charge sometimes?", OPUS_XHIGH);
  assert.equal(second.effort, "xhigh");
  assert.equal(routerDecisionLines(host).at(-1)?.reason, "effort-hysteresis");
  const third = await promptTurn(host, handlers, engine, 3, "the build fails only in CI, find out why", OPUS_XHIGH);
  assert.equal(third.effort, "high");
  const lower = routerDecisionLines(host).at(-1);
  assert.equal(lower?.reason, "effort-lower");
  assert.equal(lower?.effort, "high");
  assert.equal(typeof lower?.stepSaving, "number");
});

test("0.6.2 E2 (hook): with too few real steps the saving is unknown and the effort stays", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("frontier"), tierAnswer("complex"), tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await promptTurn(host, handlers, engine, 1, "prove this algorithm terminates", OPUS_XHIGH);
  await promptTurn(host, handlers, engine, 2, "why does checkout double-charge sometimes?", OPUS_XHIGH);
  const third = await promptTurn(host, handlers, engine, 3, "the build fails only in CI, find out why", OPUS_XHIGH);
  assert.equal(third.effort, "xhigh");
  assert.equal(routerDecisionLines(host).at(-1)?.reason, "effort-unknown-savings");
});

test("0.6.2 E3 (hook): the account's per-tier effort setting is what the router asks for", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${ACCOUNT_DIR}/settings.json`, JSON.stringify({ env: {}, pluginConfigs: { "orca-jev-mod-skills@skills-dir": { options: { routerMode: "active", routerEffort: { complex: "xhigh", simple: "bogus" } } } } }));
  host.fetchQueue.push(tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, "why does checkout double-charge sometimes?", { model: "claude-sonnet-5-5", effort: "medium" });
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.effort, "xhigh");
});

// ---------------------------------------------------------------------------
// 0.6.2 E6: a writer agent is started with a pointer prompt; Jev judges the
// pointer ("simple") and point A would start a complex job on Haiku.
// ---------------------------------------------------------------------------

const POINTER = "Read /home/dev/jobs/tmp/brief-062-effort.md completely and do what it says.";

test("0.6.2 E6 (hook, point A): a pointer prompt keeps the session's own model and effort, and logs the guard", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, POINTER, OPUS_XHIGH);
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.effort, "xhigh");
  const decision = routerDecisionLines(host).at(-1);
  assert.equal(decision?.point, "start");
  assert.equal(decision?.guard, "pointer-prompt");
  assert.equal(decision?.applied, false);
});

test("0.6.2 E6 (hook, subagent): a pointer spawn prompt keeps the parent's model", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await spawnThrough(handlers, engine, spawnEvent({ description: "Run the brief", prompt: POINTER }));
  assert.notEqual(seen.model, "claude-haiku-4-5-20251001");
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: undefined }));
  const decision = routerDecisionLines(host).at(-1);
  assert.equal(decision?.point, "subagent");
  assert.equal(decision?.guard, "pointer-prompt");
});

// ---------------------------------------------------------------------------
// 0.6.2 E8: the status line says, part by part, what applied and what only
// measured, with one "jev" at the start.
// ---------------------------------------------------------------------------

test("0.6.2 E8 (hook): skill applied + tool measuring reads as such, with one jev", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: true, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Read graft_repo_map first.");
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
  const { handlers, engine } = loadHooks(host);
  host.fetchQueue.push(
    jevResponse({ which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 }, skill_needed: { type: "noul", noul: 0.8 } }),
    jevResponse({ which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 }, "fits::graft-helper": { type: "noul", noul: 0.9 } }),
    jevResponse({ which: { type: "choice", choice: "Bash", probabilities: { Bash: 0.6 }, confidence: 0.6 }, needsOneTool: { type: "noul", noul: 0.1 } }),
  );
  await submitPrompt(handlers, engine, "how does the auth module work");
  assert.equal(host.statusLines.at(-1), "jev · skill: graft-helper (applied) · tools: no change (measuring only)");
});

test("0.6.2 E8 (hook): skill measuring only reads as such", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Read graft_repo_map first.");
  const { handlers, engine } = loadHooks(host);
  host.fetchQueue.push(
    jevResponse({ which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 }, skill_needed: { type: "noul", noul: 0.8 } }),
    jevResponse({ which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 }, "fits::graft-helper": { type: "noul", noul: 0.9 } }),
  );
  await submitPrompt(handlers, engine, "how does the auth module work");
  assert.equal(host.statusLines.at(-1), "jev · skill: graft-helper (measuring only)");
});

test("0.6.2 E8 (hook): a warm session in active mode says why it kept the model", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [
    { role: "user", text: "hi", toolUses: [] },
    { role: "assistant", text: "hello", toolUses: [] },
    { role: "user", text: "now something else", toolUses: [] },
  ];
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(host.statusLines.at(-1), "jev · model: Opus 5.5 · kept: session already started");
  assert.equal(host.fetchCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 0.6.2 F0 / review finding 2 at point B: a guard at spawn is logged, never
// lets the subagent's effort fall, and never blocks it rising.
// ---------------------------------------------------------------------------

test("F0 (hook, subagent): under a guard the subagent's effort rises to the tier's, never falls, and the guard is logged", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"), tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent({ description: "writer", prompt: "Read /x/brief.md and do what it says" }));
  const raised = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "medium" }));
  assert.equal(raised.effort, "high");
  assert.equal(routerDecisionLines(host).at(-1)?.guard, "pointer-prompt");
  assert.equal(routerDecisionLines(host).at(-1)?.effort, "high", "the log shows what the step actually sent, not the raw target");
  const kept = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 1, model: "claude-opus-5-5", effort: "xhigh" }));
  assert.equal(kept.effort, "xhigh");
});

test("nit 10 (hook): after the person switches model, the router part says it is their choice, not the old decision", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(host.statusLines.at(-1), "jev · model: Haiku 4.5");
  host.messages = [...host.messages, { role: "assistant", text: "hello", toolUses: [] }];
  await stepThrough(handlers, engine, turnStepEvent({ index: 1, model: "claude-sonnet-5-5", effort: "medium" }));
  assert.equal(host.statusLines.at(-1), "jev · model: Sonnet 5.5 · kept: your choice");
});

// JEVADV-76: Jev rejects a choice over more than 255 options with a 400, and
// sessions carry 266-448 tools once MCP servers are attached. One `which`
// over the whole roster failed on every prompt; stage 1 now asks in batches.
test("a tool roster over 255 asks stage 1 in batches that each stay within Jev's choice limit", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  host.toolList = Array.from({ length: 300 }, (_, i) => ({ name: `mcp__srv__tool_${i}`, description: `Tool ${i}`, mcp: true }));
  const { handlers, engine } = loadHooks(host);

  // Gate closed in the first batch, so stage 2 never runs.
  host.fetchQueue.push(jevResponse({
    which: { type: "choice", choice: "mcp__srv__tool_3", probabilities: { mcp__srv__tool_3: 0.6 }, confidence: 0.6 },
    needsOneTool: { type: "noul", noul: 0.1 },
  }));
  host.fetchQueue.push(jevResponse({
    which: { type: "choice", choice: "mcp__srv__tool_200", probabilities: { mcp__srv__tool_200: 0.7 }, confidence: 0.7 },
  }));

  await submitPrompt(handlers, engine, "run the build");

  const toolCalls = host.fetchCalls.filter((call) => (call.body ?? "").includes("mcp__srv__tool_"));
  assert.equal(toolCalls.length, 2, "300 tools need two stage-1 batches");
  for (const call of toolCalls) {
    const body = JSON.parse(call.body ?? "{}") as { questions: { which: { criteria: Record<string, string> } } };
    assert.ok(Object.keys(body.questions.which.criteria).length <= 255, "each batch stays within Jev's choice limit");
  }
  const record = lastDecisionRecord(host, TOOL_MEASUREMENTS_PATH) as { decision: { reason: string }; wide: { ranked: { name: string }[] } | null };
  assert.match(record.decision.reason, /no single tool needed/);
  assert.deepEqual(record.wide?.ranked.map((r) => r.name), ["mcp__srv__tool_200", "mcp__srv__tool_3"]);
});

// ---------------------------------------------------------------------------
// 0.6.8 T6: the subagents running now, in the status line -- the model each
// one runs and why. Visibility only.
// ---------------------------------------------------------------------------

async function spawnAs(handlers: Map<string, Hook>, engine: unknown, event: Record<string, unknown>, agentId: string, resolvedModel?: string): Promise<void> {
  const hook = handlers.get("agent.spawn");
  assert.ok(hook, "agent.spawn was never registered");
  await hook(engine, event, async (e: unknown) => ({ model: resolvedModel ?? String((e as { model?: string }).model ?? "claude-opus-5-5"), agentId }));
}

async function completeSubagent(handlers: Map<string, Hook>, engine: unknown, agentId: string): Promise<void> {
  const hook = handlers.get("turn.complete");
  assert.ok(hook, "turn.complete was never registered");
  await hook(engine, { agentId, turnId: `sub-${agentId}`, reason: "answer", answer: "done" }, async (e: unknown) => e);
}

function lastStatus(host: FakeHost): string {
  return String(host.statusLines[host.statusLines.length - 1] ?? "");
}

test("T6: a running subagent shows in the status line with its model and why", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  // Kept, so the explicit model stays what it was asked for (0.6.8 T7).
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  // 0.6.14 T2: the line counts; the model and why are the agent's row in the band.
  assert.match(lastStatus(host), /agents: 1$/);
  assert.match((await bandText(handlers, engine)), /Opus 5\.5 .*explicit request$/m);
});

test("T6: two subagents on the same model and reason are counted, each on its own row (0.6.14 T2)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  // Kept, so the explicit model stays what it was asked for (0.6.8 T7).
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-2", "claude-opus-5-5");
  assert.match(lastStatus(host), /agents: 2$/);
  assert.equal(((await bandText(handlers, engine))).match(/Opus 5\.5 .*explicit request$/gm)?.length, 2);
});

test("T6: a subagent that finished leaves the status line", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  await completeSubagent(handlers, engine, "agent-1");
  assert.doesNotMatch(lastStatus(host), /agents:/);
});

test("T6: a subagent the host no longer lists as running is dropped at the next spawn", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  // Kept, so the explicit model stays what it was asked for (0.6.8 T7).
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  host.agents = [{ id: "agent-1", status: "killed" }, { id: "agent-2", status: "running" }];
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-2", "claude-opus-5-5");
  assert.match(lastStatus(host), /agents: 1$/);
  assert.equal(((await bandText(handlers, engine))).match(/Opus 5\.5/g)?.length, 1);
});

test("T6: with the router off a subagent still shows, on the model it inherited", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await spawnAs(handlers, engine, spawnEvent(), "agent-1", "claude-sonnet-5-5");
  assert.match(lastStatus(host), /agents: 1$/);
  assert.match((await bandText(handlers, engine)), /Sonnet .*inherited$/m);
});

test("T6: a subagent the router chose a model for says so (active mode)", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent(), "agent-1");
  assert.match(lastStatus(host), /agents: 1$/);
  assert.match((await bandText(handlers, engine)), /Haiku 4\.5 .*chosen by Jev$/m);
});

// ---------------------------------------------------------------------------
// 0.6.14 T1: each running subagent is kept with its type, description,
// model, effort and why, in `$.state` (it survives a plugin reload); one the
// host runs that nothing recorded still counts, as "no data".
// ---------------------------------------------------------------------------

interface StoredSubagent {
  id: string;
  type: string;
  description: string;
  label: string | null;
  effort: string | number | null;
  /** 0.6.15 T4b. */
  effortSource?: string | null;
  why: string;
  wouldUse: string | null;
  /** 0.6.23 T1. */
  place?: { worktree: string | null; branch: string | null; apart: boolean; pendingIsolation?: true };
}

/** Raises session.start, as a load (or a reload) does. */
async function startSession(handlers: Map<string, Hook>, engine: unknown): Promise<void> {
  const start = handlers.get("session.start");
  assert.ok(start, "session.start was never registered");
  await start(engine, { source: "startup" }, async (e: unknown) => e);
}

function storedSubagents(host: FakeHost): StoredSubagent[] {
  const value = host.state.get("runningSubagents") as { agents: StoredSubagent[] } | undefined;
  return value?.agents ?? [];
}

test("0.6.14 T1: a started subagent is stored with its type, description, model and why", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus", subagentType: "acme-frontend-developer", description: "Adding Definition of Done to spec.md" }), "agent-1", "claude-opus-5-5");
  assert.deepEqual(storedSubagents(host), [
    // 0.6.15 T4b: its effort's source is unknown (null) until its first step.
    { id: "agent-1", type: "acme-frontend-developer", description: "Adding Definition of Done to spec.md", label: "Opus 5.5", effort: null, effortSource: null, why: "explicit", wouldUse: null },
  ]);
});

test("0.6.14 T1: the effort a subagent's step is sent is stored with it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent());
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "xhigh" }));
  assert.equal(storedSubagents(host)[0]?.effort, "medium", "what turn.step sent, not what it carried");
  assert.equal(storedSubagents(host)[0]?.effortSource, "jev", "0.6.15 T4b: the router set it");
});

// 0.6.15 T4b: an agent whose model is fixed runs at the effort the engine put
// on its step (inherited from the session, its model settings or its
// definition); the band shows that level and says where it came from.
test("0.6.15 T4b: a fixed-model subagent stores the effort its step carries, as inherited", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus", subagentType: "acme-frontend-developer", description: "Fixed model" }), "agent-1", "claude-opus-5-5");
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "high" }));
  assert.equal(step.effort, "high", "visibility only: the effort sent is unchanged");
  assert.deepEqual([storedSubagents(host)[0]?.effort, storedSubagents(host)[0]?.effortSource], ["high", "inherited"]);
});

test("0.6.14 T1: measure mode stores the model it would use", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  await spawnAs(handlers, engine, spawnEvent(), "agent-1", "claude-opus-5-5");
  const [stored] = storedSubagents(host);
  assert.equal(stored?.label, "Opus 5.5");
  assert.equal(stored?.why, "measuring");
  assert.equal(stored?.wouldUse, "Haiku 4.5");
});

test("0.6.14 T1: after a plugin reload the running set is still there, and an agent nothing recorded still counts", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
  const first = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(first.handlers, first.engine, spawnEvent({ model: "opus", subagentType: "acme-frontend-developer", description: "Adding Definition of Done to spec.md" }), "agent-1", "claude-opus-5-5");
  // A reload: register runs again, the module's own variables start over, `$.state` stays.
  const second = loadHooksWith(host, { routerMode: "active" });
  host.agents = [
    { id: "agent-0", status: "running", type: "acme-frontend-developer", description: "Reading playwright.config.ts" },
    { id: "agent-1", status: "running", type: "acme-frontend-developer", description: "Adding Definition of Done to spec.md" },
  ];
  // 0.6.20 T2: the reload's session.start sees agent-0 already running.
  await startSession(second.handlers, second.engine);
  host.agents = [...host.agents, { id: "agent-2", status: "running", type: "acme-backend-developer", description: "Watching CI checks on PR 867" }];
  await spawnAs(second.handlers, second.engine, spawnEvent({ model: "sonnet", subagentType: "acme-backend-developer", description: "Watching CI checks on PR 867" }), "agent-2", "claude-sonnet-5-5");
  assert.deepEqual(storedSubagents(host).map((a) => a.id), ["agent-1", "agent-2"], "the record made before the reload is kept");
  assert.match(lastStatus(host), /(^|· )agents: 3$/);
  const rows = (await bandText(second.handlers, second.engine)).split("\n");
  assert.match(rows[1] ?? "", /Reading playwright\.config\.ts +\? +\? +started before the plugin loaded$/);
  assert.match(rows[2] ?? "", /Adding Definition of Done to spec\.md +Opus 5\.5 .*explicit request$/);
  assert.match(rows[3] ?? "", /Watching CI checks on PR 867 +Sonnet 5\.5 .*explicit request$/);
});

test("0.6.14 T1: a reload shows the running set at session start, before any new spawn", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"));
  const first = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(first.handlers, first.engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  const second = loadHooksWith(host, { routerMode: "active" });
  host.agents = [{ id: "agent-1", status: "running", type: "general-purpose", description: "List files" }];
  const start = second.handlers.get("session.start");
  assert.ok(start, "session.start was never registered");
  await start(second.engine, { source: "startup" }, async (e: unknown) => e);
  assert.match(lastStatus(host), /(^|· )agents: 1$/);
  assert.match(await bandText(second.handlers, second.engine), /List files +Opus 5\.5 .*explicit request$/m);
});

// ---------------------------------------------------------------------------
// 0.6.14 T2: one row per running subagent in the band above the prompt
// (ui.render, AbovePrompt); the status line only counts them.
// ---------------------------------------------------------------------------

interface FakeElement {
  type: string;
  props: Record<string, unknown>;
}

const ENGINE_DRAWING = { type: "engine", ref: 0 };

function abovePromptEvent(columns: number, hasSurvey = false): Record<string, unknown> {
  return {
    component: "AbovePrompt",
    surface: "terminal",
    requestId: "above-prompt",
    props: { hasSurvey, isWorking: true, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  };
}

/** Runs the band's render hook; `beneath` is what the plugins beneath (or the engine) drew. */
async function renderBand(handlers: Map<string, Hook>, engine: unknown, columns = 200, options: { hasSurvey?: boolean; beneath?: unknown } = {}): Promise<unknown> {
  const hook = handlers.get("ui.render");
  assert.ok(hook, "ui.render was never registered");
  return hook(engine, abovePromptEvent(columns, options.hasSurvey), async () => options.beneath ?? ENGINE_DRAWING);
}

/** The band's lines at 200 columns, one string. */
async function bandText(handlers: Map<string, Hook>, engine: unknown): Promise<string> {
  return bandLines(await renderBand(handlers, engine, 200)).join("\n");
}

/** A drawn tree as the lines a terminal shows: each Text child of the column Box, its nested Texts joined. */
function bandLines(tree: unknown): string[] {
  const text = (node: unknown): string => {
    if (typeof node === "string") return node;
    const children = (node as FakeElement).props.children;
    return (Array.isArray(children) ? children : [children]).map(text).join("");
  };
  const root = tree as FakeElement;
  assert.equal(root.type, "Box", `a band is a column Box, got ${JSON.stringify(tree)}`);
  return (root.props.children as unknown[]).map(text);
}

test("0.6.14 T2: the owner's four agents, each on its own row with its own model, effort and reason", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("standard"), tierAnswer("simple"));
  const first = loadHooksWith(host, { routerMode: "active" });
  // One agent started before the reload, when nothing recorded it; the reload's session.start sees it running (0.6.20 T2).
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  host.agents = [{ id: "agent-0", status: "running", type: "acme-frontend-developer", description: "Reading playwright.config.ts" }];
  await startSession(handlers, engine);
  // As before 0.6.20: the spawns below run with no host list, so none prunes another.
  host.agents = null;
  const keep = (): void => {
    host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  };
  void first;
  keep();
  await spawnAs(handlers, engine, spawnEvent({ model: "opus", subagentType: "acme-frontend-developer", description: "Adding Definition of Done to spec.md" }), "agent-1", "claude-opus-5-5");
  host.files.delete(`${CONFIG_DIR}/explicit-models.json`);
  await spawnAs(handlers, engine, spawnEvent({ model: "opus", subagentType: "general-purpose", description: "Creating a worktree for verify-report generation" }), "agent-2");
  keep();
  await spawnAs(handlers, engine, spawnEvent({ model: "sonnet", subagentType: "acme-backend-developer", description: "Watching CI checks on PR 867" }), "agent-3", "claude-sonnet-5-5");
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "xhigh" }));
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-2", turnId: "sub-2", index: 0, model: "claude-sonnet-5-5", effort: "medium" }));
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-3", turnId: "sub-3", index: 0, model: "claude-sonnet-5-5", effort: "high" }));
  host.agents = [
    { id: "agent-0", status: "running", type: "acme-frontend-developer", description: "Reading playwright.config.ts" },
    { id: "agent-1", status: "running", type: "acme-frontend-developer", description: "Adding Definition of Done to spec.md" },
    { id: "agent-2", status: "running", type: "general-purpose", description: "Creating a worktree for verify-report generation" },
    { id: "agent-3", status: "running", type: "acme-backend-developer", description: "Watching CI checks on PR 867" },
  ];
  const lines = bandLines(await renderBand(handlers, engine, 200));
  assert.equal(lines[0], "Running agents: 4");
  assert.equal(lines.length, 5);
  assert.match(lines[1] ?? "", /^frontend-developer +Reading playwright\.config\.ts +\? +\? +started before the plugin loaded$/);
  // 0.6.15 T4b: each effort names its source, read off the agent's step (all three kept the level the engine put on it).
  assert.match(lines[2] ?? "", /^frontend-developer +Adding Definition of Done to spec\.md +Opus 5\.5 +extra high \(inherited\) +explicit request$/);
  assert.match(lines[3] ?? "", /^general-purpose +Creating a worktree for verify-report generation +Sonnet 5\.5 +medium \(inherited\) +lowered by Jev$/);
  assert.match(lines[4] ?? "", /^backend-developer +Watching CI checks on PR 867 +Sonnet 5\.5 +high \(inherited\) +explicit request$/);
});

test("0.6.14 T2: the status line only counts the running agents, the count the host lists", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  host.agents = [
    { id: "agent-0", status: "running", type: "general-purpose", description: "Started before the reload" },
    { id: "agent-1", status: "running", type: "general-purpose", description: "List files" },
  ];
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  assert.match(lastStatus(host), /(^|· )agents: 2$/);
});

test("0.6.14 T2: the band passes while nothing runs, and after the last agent ends", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  assert.deepEqual(await renderBand(handlers, engine), ENGINE_DRAWING);
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  assert.equal(bandLines(await renderBand(handlers, engine))[0], "Running agents: 1");
  await completeSubagent(handlers, engine, "agent-1");
  assert.deepEqual(await renderBand(handlers, engine), ENGINE_DRAWING);
});

test("0.6.14 T2: the band yields to a survey and never replaces another plugin's band", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  assert.deepEqual(await renderBand(handlers, engine, 120, { hasSurvey: true }), ENGINE_DRAWING);
  const other = { type: "Text", props: { children: "another plugin's band" } };
  assert.deepEqual(await renderBand(handlers, engine, 120, { beneath: other }), other);
});

test("0.6.14 T2: the band is sized to the band's own width", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus", description: "A description long enough that forty columns cannot hold it whole" }), "agent-1", "claude-opus-5-5");
  for (const columns of [200, 120, 80, 40]) {
    for (const line of bandLines(await renderBand(handlers, engine, columns))) assert.ok(line.length <= columns, `${columns}: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// 0.6.20 T2: an agent the plugin did not see at `agent.spawn` (an agent-team
// teammate, which Claude Code creates outside it) shows the model and effort
// its own steps report, and the true reason -- never a reload it cannot show.
// ---------------------------------------------------------------------------

test("0.6.20 T2: a teammate no spawn recorded says so, and shows the model and effort of its first step", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await startSession(handlers, engine);
  host.agents = [{ id: "tm-1", status: "running", type: "teammate", description: "researcher" }];
  assert.match(await bandText(handlers, engine), /^teammate +researcher +\? +\? +teammate: created outside the router$/m, "before its first step: no model or effort, and no reload guessed");
  // The T1 probe: a teammate's step event names the lead's model; the model it ran on is the step result's.
  const event = turnStepEvent({ agentId: "tm-1", turnId: "tm-turn-1", index: 0, model: "claude-sonnet-5-5", effort: "high" });
  const sent = await stepThrough(handlers, engine, event, turnStepResult({ turnId: "tm-turn-1", usage: { ...(turnStepResult().usage as Record<string, unknown>), model: "claude-opus-5-5" } }));
  assert.deepEqual([sent.model, sent.effort], ["claude-sonnet-5-5", "high"], "visibility only: the step is sent as it came");
  assert.match(await bandText(handlers, engine), /^teammate +researcher +Opus 5\.5 +high \(inherited\) +teammate: created outside the router$/m);
  assert.deepEqual(storedSubagents(host).map((a) => [a.id, a.why, a.label, a.effort, a.effortSource]), [["tm-1", "teammate", "Opus 5.5", "high", "inherited"]]);
});

test("0.6.20 T2: a teammate's turn ending does not end its row while the host still runs it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  host.agents = [{ id: "tm-1", status: "running", type: "teammate", description: "researcher" }];
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "tm-1", turnId: "tm-turn-1", index: 0, model: "claude-sonnet-5-5", effort: "high" }), turnStepResult({ turnId: "tm-turn-1", usage: { ...(turnStepResult().usage as Record<string, unknown>), model: "claude-opus-5-5" } }));
  await completeSubagent(handlers, engine, "tm-1");
  assert.match(await bandText(handlers, engine), /^teammate +researcher +Opus 5\.5 +high \(inherited\) /m);
  host.agents = [{ id: "tm-1", status: "completed", type: "teammate", description: "researcher" }];
  assert.deepEqual(await renderBand(handlers, engine), ENGINE_DRAWING, "gone once the host no longer runs it");
});

test("0.6.20 T2: an agent running when this load started reads as started before the plugin loaded; one that came after, as not seen at launch", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  host.agents = [{ id: "agent-0", status: "running", type: "general-purpose", description: "Started earlier" }];
  await startSession(handlers, engine);
  host.agents = [...host.agents, { id: "agent-9", status: "running", type: "Explore", description: "Started later" }];
  const text = await bandText(handlers, engine);
  assert.match(text, /Started earlier +\? +\? +started before the plugin loaded$/m);
  assert.match(text, /Started later +\? +\? +not seen at launch$/m);
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-9", turnId: "sub-9", index: 0, model: "claude-sonnet-5-5", effort: undefined }), turnStepResult({ turnId: "sub-9", usage: { ...(turnStepResult().usage as Record<string, unknown>), model: "claude-haiku-4-5-20251001" } }));
  assert.match(await bandText(handlers, engine), /Started later +Haiku 4\.5 +— +not seen at launch$/m, "its model from its step; no effort sent reads as a dash");
});

test("0.6.20 T2: a step from a loop the host does not list (an engine fork) adds no row", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  host.agents = [];
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "fork-1", turnId: "fork-turn", index: 0, model: "claude-haiku-4-5-20251001", effort: "low" }));
  assert.deepEqual(storedSubagents(host), []);
  assert.deepEqual(await renderBand(handlers, engine), ENGINE_DRAWING);
});

// ---------------------------------------------------------------------------
// 0.6.8 T7: a model fixed by the Agent call or an agent definition is judged
// (the default), lowered only in active mode and under the usual guards.
// ---------------------------------------------------------------------------

test("T7: active, judged by default -- a confident simple verdict lowers an explicit model", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await spawnThrough(handlers, engine, spawnEvent({ model: "opus" }));
  assert.equal(seen.model, "claude-haiku-4-5-20251001");
  assert.match((await bandText(handlers, engine)), /Haiku 4\.5 .*lowered by Jev$/m);
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-haiku-4-5-20251001", effort: undefined }));
  assert.equal(routerDecisionLines(host)[0]?.reason, "explicit-lowered");
});

test("T7: measure mode never lowers an explicit model, it only logs what it would do", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  const event = spawnEvent({ model: "opus" });
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
});

test("T7: a guard keeps the explicit model even when judged", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple", 0.5));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = spawnEvent({ model: "opus" });
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
});

test("T7: a model an agent definition fixes is kept when the person keeps them", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.files.set(`${CWD}/.claude/agents/reviewer.md`, "---\nname: reviewer\nmodel: opus\n---\nReview.\n");
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = spawnEvent({ subagentType: "reviewer" });
  assert.deepEqual(await spawnThrough(handlers, engine, event), event, "the definition's own model is left to apply");
  assert.match((await bandText(handlers, engine)), /explicit request$/m);
});

test("T7: a model an agent definition fixes is judged like an explicit one by default", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CWD}/.claude/agents/reviewer.md`, "---\nname: reviewer\nmodel: opus\n---\nReview.\n");
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await spawnThrough(handlers, engine, spawnEvent({ subagentType: "reviewer" }));
  assert.equal(seen.model, "claude-haiku-4-5-20251001");
  assert.match((await bandText(handlers, engine)), /lowered by Jev$/m);
});

// ---------------------------------------------------------------------------
// 0.6.16 T2: the work kind at spawn, asked in the same Jev call as the tier.
// ---------------------------------------------------------------------------

function tierKindAnswer(tier: string, kind: string, kindConfidence = 0.9): unknown {
  return jevResponse({
    tier: { type: "choice", choice: tier, probabilities: { [tier]: 0.9 }, confidence: 0.9 },
    kind: { type: "choice", choice: kind, probabilities: { [kind]: kindConfidence }, confidence: kindConfidence },
  });
}

function seedWorkKind(host: FakeHost, mode: string, routerEffort?: Record<string, string>): void {
  host.files.set(`${ACCOUNT_DIR}/settings.json`, JSON.stringify({ env: {}, pluginConfigs: { "orca-jev-mod-skills@skills-dir": { options: { workKindMode: mode, ...(routerEffort === undefined ? {} : { routerEffort }) } } } }));
}

const READ_SPAWN = { description: "Find the router's log writer", prompt: "Find where the router writes its decision log and report the file and function.", model: "sonnet" };

test("0.6.16 T2 (active): a read run on Sonnet 5 is capped at high, set at its first step and kept", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedWorkKind(host, "active");
  host.fetchQueue.push(tierKindAnswer("standard", "read"));
  const { handlers, engine } = loadHooks(host);
  await spawnAs(handlers, engine, spawnEvent(READ_SPAWN), "agent-1", "claude-sonnet-5");
  const questions = (JSON.parse(host.fetchCalls.at(-1)?.body ?? "{}") as { questions: Record<string, unknown> }).questions;
  assert.deepEqual(Object.keys(questions).sort(), ["kind", "tier"], "one call, both questions");
  const first = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(first.effort, "high");
  const later = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 1, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(later.effort, "high");
  assert.equal(host.fetchCalls.length, 1);
  const kind = routerDecisionLines(host).at(-1)?.workKind as Record<string, unknown>;
  assert.deepEqual(kind, { mode: "active", kind: "read", confidence: 0.9, source: "jev", keywords: "read", effort: "high", hold: null, applied: true });
  assert.equal(routerDecisionLines(host).at(-1)?.effort, "high");
});

test("0.6.16 T2 (measure, the default): the kind and the effort it would send are logged, nothing sent changes", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierKindAnswer("complex", "execute", 0.8));
  const { handlers, engine } = loadHooks(host);
  await spawnAs(handlers, engine, spawnEvent({ description: "Run the test suite", prompt: "Run npm test and report the failures." }), "agent-1", "claude-opus-5-5");
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "high" }));
  assert.equal(step.effort, "high");
  const kind = routerDecisionLines(host).at(-1)?.workKind as Record<string, unknown>;
  assert.deepEqual(kind, { mode: "measure", kind: "execute", confidence: 0.8, source: "jev", keywords: "execute", effort: "medium", hold: null, applied: false });
});

test("0.6.16 T2 (off): the spawn asks only for the tier and logs no kind", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedWorkKind(host, "off");
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooks(host);
  await spawnAs(handlers, engine, spawnEvent(READ_SPAWN), "agent-1", "claude-sonnet-5");
  const questions = (JSON.parse(host.fetchCalls.at(-1)?.body ?? "{}") as { questions: Record<string, unknown> }).questions;
  assert.deepEqual(Object.keys(questions), ["tier"]);
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh");
  assert.equal(routerDecisionLines(host).at(-1)?.workKind, null);
});

test("0.6.16 T2 (active): with no answer from Jev the keywords name the kind, logged, and never act", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedWorkKind(host, "active");
  const { handlers, engine } = loadHooks(host);
  await spawnAs(handlers, engine, spawnEvent(READ_SPAWN), "agent-1", "claude-sonnet-5");
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh");
  const kind = routerDecisionLines(host).at(-1)?.workKind as Record<string, unknown>;
  assert.deepEqual([kind.kind, kind.source, kind.confidence, kind.hold, kind.applied], ["read", "keywords", null, "unsure", false]);
});

test("0.6.16 T2 (active): review work, a sensitive topic and a client's site keep the effort", async () => {
  for (const [answer, spawn, hold] of [
    [tierKindAnswer("standard", "review"), READ_SPAWN, "not-read-work"],
    [tierKindAnswer("standard", "read"), { ...READ_SPAWN, prompt: "Read the production deploy logs and report errors." }, "sensitive"],
  ] as const) {
    const host = makeFakeHost();
    seedRouterAccount(host);
    seedWorkKind(host, "active");
    host.fetchQueue.push(answer);
    const { handlers, engine } = loadHooks(host);
    await spawnAs(handlers, engine, spawnEvent(spawn), "agent-1", "claude-sonnet-5");
    const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
    assert.equal(step.effort, "xhigh", hold);
    assert.equal((routerDecisionLines(host).at(-1)?.workKind as Record<string, unknown>).hold, hold);
  }
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedWorkKind(host, "active");
  seedCatalog(host, "client-site");
  host.fetchQueue.push(tierKindAnswer("standard", "read"));
  const { handlers, engine } = loadHooks(host);
  await spawnAs(handlers, engine, spawnEvent(READ_SPAWN), "agent-1", "claude-sonnet-5");
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh");
  assert.equal((routerDecisionLines(host).at(-1)?.workKind as Record<string, unknown>).hold, "client-site");
});

test("0.6.16 T1/T2 (active): on read work the simple tier's own low comes back, unless the person set simple themselves", async () => {
  const noHaiku = SEED_MODELS.map((model) => (model.id.startsWith("claude-haiku") ? { ...model, available: false } : model));
  for (const [routerEffort, workKind, expected] of [[undefined, "active", "low"], [{ simple: "medium" }, "active", "medium"], [undefined, "measure", "medium"]] as const) {
    const host = makeFakeHost();
    seedRouterAccount(host);
    host.files.set(`${CONFIG_DIR}/models-catalog.json`, JSON.stringify({ active: false, ready: false, models: noHaiku }));
    seedWorkKind(host, workKind, routerEffort);
    host.fetchQueue.push(tierKindAnswer("simple", "read"));
    const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
    const seen = await spawnThrough(handlers, engine, spawnEvent({ description: READ_SPAWN.description, prompt: READ_SPAWN.prompt }));
    assert.equal(seen.model, "claude-sonnet-5-5");
    const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "high" }));
    assert.equal(step.effort, expected, `${JSON.stringify(routerEffort)} ${workKind}`);
  }
});

// ---------------------------------------------------------------------------
// 0.6.16 T3: an agent definition's declared effort is a floor.
// ---------------------------------------------------------------------------

test("0.6.16 T3: a definition that declares high keeps high when the tier asks for medium, and the band says it is the definition's", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CWD}/.claude/agents/checker.md`, "---\nname: checker\neffort: high\n---\nCheck.\n");
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ subagentType: "checker", parentModel: "claude-sonnet-5-5" }), "agent-1", "claude-sonnet-5-5");
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "high" }));
  assert.equal(step.effort, "high", "the tier's medium never lowers a declared high");
  assert.equal(storedSubagents(host)[0]?.effortSource, "frontmatter");
  assert.equal(routerDecisionLines(host).at(-1)?.effort, "high");
});

test("0.6.16 T3: the router may still raise a declared effort", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CWD}/.claude/agents/checker.md`, "---\nname: checker\neffort: medium\n---\nCheck.\n");
  host.fetchQueue.push(tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ subagentType: "checker" }), "agent-1", "claude-opus-5-5");
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "medium" }));
  assert.equal(step.effort, "high");
  assert.equal(storedSubagents(host)[0]?.effortSource, "jev");
});

// ---------------------------------------------------------------------------
// 0.6.15 T4c (odd/research/effort-per-task.md §4): measure-only effort
// logging on each turn-usage line. Nothing about the effort sent changes.
// ---------------------------------------------------------------------------

function turnUsageLines(host: FakeHost): Record<string, unknown>[] {
  return (host.files.get(TURN_USAGE_PATH) ?? "").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("0.6.15 T4c: a main step logs the effort's source; the first step after an effort change logs its uncached share", async () => {
  const host = makeFakeHost();
  host.env.set("CLAUDE_CODE_EFFORT_LEVEL", "high");
  const { handlers, engine } = loadHooks(host);
  const first = await stepThrough(handlers, engine, turnStepEvent({ model: "claude-opus-5-5", effort: "high" }));
  assert.equal(first.effort, "high", "the effort sent is unchanged");
  await stepThrough(handlers, engine, turnStepEvent({ model: "claude-opus-5-5", effort: "medium", index: 1 }));
  const [one, two] = turnUsageLines(host);
  assert.equal(one?.effortSource, "env");
  assert.equal(one?.effortChanged, false);
  assert.equal(one?.uncachedShare, undefined, "no uncached share without a change");
  assert.equal(two?.effortSource, "default", "medium is Opus 5.5's own default in Claude Code");
  assert.equal(two?.effortChanged, true);
  assert.equal(two?.uncachedShare, 0.057);
  assert.equal(one?.modelFixed, null, "the main loop's model is the session's own");
});

test("0.6.15 T4c: a subagent step logs the router's effort, the source, and whether its model was fixed", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent());
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "xhigh" }));
  const line = turnUsageLines(host).at(-1);
  assert.deepEqual([line?.effort, line?.effortSource, line?.routerEffort, line?.modelFixed], ["medium", "plugin", "medium", false]);
});

test("0.6.15 T4c: a fixed-model subagent whose definition sets the effort logs it as frontmatter", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CONFIG_DIR}/explicit-models.json`, JSON.stringify({ mode: "keep" }));
  host.files.set(`${CWD}/.claude/agents/reviewer.md`, "---\nname: reviewer\nmodel: opus\neffort: high\n---\nReview.\n");
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ subagentType: "reviewer" }), "agent-1", "claude-opus-5-5");
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "high" }));
  assert.equal(step.effort, "high");
  const line = turnUsageLines(host).at(-1);
  assert.deepEqual([line?.effortSource, line?.modelFixed], ["frontmatter", true]);
});

// ---------------------------------------------------------------------------
// 0.6.16 T4: main-session phase and the would-be hold effort, measure only.
// ---------------------------------------------------------------------------

function toolStep(index: number, tools: { name: string; input: Record<string, unknown> }[], stopReason = "tool_use"): Record<string, unknown> {
  return turnStepResult({ index, toolUses: tools, stopReason, usage: { model: "claude-opus-5-5", input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 100 } });
}

/**
 * A `tool.call` event as Claude Code delivers it: the tool's arguments on the
 * event itself (`e.command` for Bash), never under an `input` key. 0.6.18 T2:
 * this helper used to send `{ tool, input }`, the one shape the hook read and
 * the engine never sends, so a failed test run never reached the hold rule.
 */
async function toolCallThrough(handlers: Map<string, Hook>, engine: unknown, tool: string, input: Record<string, unknown>, outcome: Record<string, unknown>): Promise<void> {
  const hook = handlers.get("tool.call");
  assert.ok(hook);
  await hook(engine, { ...input, tool, tool_use_id: "toolu_x" }, async () => outcome);
}

test("0.6.16 T4: each main step logs its phase, the previous one, the EXEC run and what the hold rule would send; nothing sent changes", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const read = { name: "Grep", input: { pattern: "x" } };
  for (let index = 0; index < 7; index += 1) {
    const sent = await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-9", index, model: "claude-opus-5-5", effort: "high" }), toolStep(index, [read]));
    assert.equal(sent.effort, "high", "the effort sent never changes");
  }
  const rows = turnUsageLines(host);
  assert.deepEqual(rows.map((row) => row.phase), ["READ", "READ", "READ", "READ", "READ", "READ", "READ"]);
  assert.deepEqual(rows.map((row) => row.prevPhase), [null, "READ", "READ", "READ", "READ", "READ", "READ"]);
  assert.deepEqual(rows.map((row) => row.execRun), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows.map((row) => row.holdEffort), ["high", "high", "high", "high", "high", "medium", "medium"]);
  assert.equal(rows[0]?.perTurnEffort, undefined, "the hook cannot see perTurnEffort, so it is not invented");
});

test("0.6.16 T4: a failed tool in the run and a new turn raise the would-be effort back", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const run = { name: "Bash", input: { command: "npm test" } };
  for (let index = 0; index < 6; index += 1) {
    await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-1", index, model: "claude-opus-5-5", effort: "xhigh" }), toolStep(index, [run]));
    if (index === 3) await toolCallThrough(handlers, engine, "Bash", run.input, { result: {}, text: "tests 4\n✖ one failing", ref: 1 });
  }
  await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-2", index: 0, model: "claude-opus-5-5", effort: "xhigh" }), toolStep(0, [], "end_turn"));
  const rows = turnUsageLines(host);
  assert.deepEqual(rows.map((row) => row.holdEffort), ["xhigh", "xhigh", "xhigh", "xhigh", "xhigh", "xhigh", "xhigh"]);
  assert.deepEqual([rows.at(-1)?.phase, rows.at(-1)?.prevPhase, rows.at(-1)?.execRun], ["ANSWER", null, 0]);
});

test("0.6.16 T4: the first step after an effort change also logs the effort before it and the prompt size", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  await stepThrough(handlers, engine, turnStepEvent({ model: "claude-opus-5-5", effort: "high" }), toolStep(0, []));
  await stepThrough(handlers, engine, turnStepEvent({ model: "claude-opus-5-5", effort: "medium", index: 1 }), toolStep(1, []));
  const [one, two] = turnUsageLines(host);
  assert.equal(one?.prevEffort, undefined);
  assert.deepEqual([two?.effortChanged, two?.prevEffort, two?.promptTokens, two?.uncachedShare], [true, "high", 40_110, 0.003]);
});

// ---------------------------------------------------------------------------
// 0.6.19 M8 (JEVADV-73): skill.prompt observes, and observing must never cost
// the skill its load. A rejected $.clock.now() used to escape the handler
// before next(e), so the engine never got the event back.
// ---------------------------------------------------------------------------

test("skill.prompt: a rejected clock read still hands the event to next, and records nothing", async () => {
  const host = makeFakeHost();
  seedModSkillsConfig(host, { active: false, activeTools: false });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 40 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Body.");
  const { handlers, engine } = loadHooks(host);
  host.fetchQueue.push(
    jevResponse({
      which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
      skill_needed: { type: "noul", noul: 0.05 },
    }),
  );
  await submitPrompt(handlers, engine, "first prompt");
  const before = host.files.get(SKILL_MEASUREMENTS_PATH);

  const baseEngine = engine as { clock: { now: () => Promise<number> } };
  baseEngine.clock.now = async () => {
    throw new Error("clock unavailable");
  };
  const skillPrompt = handlers.get("skill.prompt");
  assert.ok(skillPrompt);
  const event = { skill: "graft-helper", origin: { kind: "user" } };
  let handed: unknown = null;
  await assert.doesNotReject(async () => {
    await skillPrompt(engine, event, async (e: unknown) => {
      handed = e;
      return e;
    });
  });
  assert.equal(handed, event, "next(e) must always be reached");
  assert.equal(host.files.get(SKILL_MEASUREMENTS_PATH), before, "no observation is written without a time");
});

// ---------------------------------------------------------------------------
// 0.6.20 T3: an agent-team teammate is routed at its first step. agent.spawn
// never fires for one (T1 probe); the lead's own Agent tool.call carries its
// task, and its first turn.step comes before anything else about it. The
// decision is the spawn's (same Jev call, guards, work kind, definition
// floor), made once and applied to every later step of that teammate. Its
// step event names the lead's model and effort, not its own.
// ---------------------------------------------------------------------------

const TEAMMATE = { id: "aresearcher-1a2b", status: "running", type: "teammate", name: "researcher", description: "researcher" };
const TEAMMATE_CALL = { name: "researcher", description: "List files", prompt: "List every file under src/ and summarise what each one does in one line." };

/** The lead's Agent call that makes the teammate, on the main loop. */
async function leadCallsTeammate(handlers: Map<string, Hook>, engine: unknown, call: Record<string, unknown> = TEAMMATE_CALL): Promise<void> {
  await toolCallThrough(handlers, engine, "Agent", call, { result: { status: "teammate_spawned" } });
}

/** One of the teammate's steps: the event names the lead's model and effort (T1 probe). */
function teammateStep(index: number): Record<string, unknown> {
  return turnStepEvent({ agentId: TEAMMATE.id, turnId: "tm-turn-1", index, model: "claude-opus-5-5", effort: "xhigh" });
}

test("0.6.20 T3 (active): a teammate is routed at its first step and kept there, with one Jev call and a teammate decision row", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await leadCallsTeammate(handlers, engine);
  host.agents = [TEAMMATE];
  const first = await stepThrough(handlers, engine, teammateStep(0));
  assert.deepEqual([first.model, first.effort], ["claude-sonnet-5-5", "medium"]);
  const later = await stepThrough(handlers, engine, teammateStep(1));
  assert.deepEqual([later.model, later.effort], ["claude-sonnet-5-5", "medium"], "the decision holds for the teammate's life");
  assert.equal(host.fetchCalls.length, 1, "decided once");
  const rows = routerDecisionLines(host);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.point, rows[0]?.agentId, rows[0]?.applied, rows[0]?.effort, rows[0]?.teammateTask], ["teammate", TEAMMATE.id, true, "medium", "matched"]);
  assert.equal(JSON.stringify(rows[0]).includes("summarise"), false, "no prompt text in the log");
  assert.match(await bandText(handlers, engine), /^teammate +researcher +Sonnet 5\.5 +medium \(Jev\) +teammate: routed at its first step$/m);
});

test("0.6.20 T3 (measure, the default): a teammate's decision is logged and nothing sent changes", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  await leadCallsTeammate(handlers, engine);
  host.agents = [TEAMMATE];
  const event = teammateStep(0);
  assert.deepEqual(await stepThrough(handlers, engine, event, turnStepResult({ usage: { ...(turnStepResult().usage as Record<string, unknown>), model: "claude-opus-5-5" } })), event);
  const [row] = routerDecisionLines(host);
  assert.deepEqual([row?.point, row?.applied, row?.proposed], ["teammate", false, "claude-haiku-4-5-20251001"]);
  assert.match(await bandText(handlers, engine), /^teammate +researcher +Opus 5\.5 +.*teammate: created outside the router · would use: Haiku 4\.5$/m);
});

test("0.6.20 T3: with no task kept for it (a reload forgot it) a teammate is not routed, and the row says the task was missing", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  host.agents = [TEAMMATE];
  const event = turnStepEvent({ ...FRESH_START, agentId: TEAMMATE.id });
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  assert.equal(host.fetchCalls.length, 0);
  const rows = routerDecisionLines(host);
  assert.deepEqual(rows.map((row) => [row.point, row.reason, row.applied, row.teammateTask]), [["teammate", "jev-failed", false, "missing"]]);
  assert.equal(host.state.get("routerSticky"), undefined, "never taken for a main-loop step");
  assert.match(await bandText(handlers, engine), /teammate: created outside the router$/m);
});

test("0.6.20 T3: with Jev down a teammate is left as it came, like a spawn", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await leadCallsTeammate(handlers, engine);
  host.agents = [TEAMMATE];
  const event = teammateStep(0);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  const [row] = routerDecisionLines(host);
  assert.deepEqual([row?.point, row?.reason, row?.applied, row?.teammateTask], ["teammate", "jev-failed", false, "matched"]);
});

test("0.6.20 T3 (off): a teammate is neither routed nor logged", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await leadCallsTeammate(handlers, engine);
  host.agents = [TEAMMATE];
  const event = teammateStep(0);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  assert.deepEqual(routerDecisionLines(host), []);
  assert.equal(host.fetchCalls.length, 0);
});

test("0.6.20 T3 (active): a teammate whose agent definition declares an effort never goes below it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${CWD}/.claude/agents/checker.md`, "---\nname: checker\neffort: high\n---\nCheck.\n");
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await leadCallsTeammate(handlers, engine, { ...TEAMMATE_CALL, subagent_type: "checker" });
  host.agents = [TEAMMATE];
  const first = await stepThrough(handlers, engine, teammateStep(0));
  assert.deepEqual([first.model, first.effort], ["claude-sonnet-5-5", "high"]);
});

test("0.6.20 T3: an ordinary subagent's named Agent call that agent.spawn routes is routed there, never twice", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await leadCallsTeammate(handlers, engine);
  await spawnThrough(handlers, engine, spawnEvent());
  host.agents = [{ id: "agent-1", status: "running", type: "general-purpose", description: "List files" }];
  const first = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5-5", effort: "xhigh" }));
  assert.equal(first.effort, "medium");
  assert.deepEqual(routerDecisionLines(host).map((row) => row.point), ["subagent"]);
  assert.equal(host.fetchCalls.length, 1);
});

// ---------------------------------------------------------------------------
// 0.6.23 T1 (JEVADV-102): where each running agent works. Its place is set at
// agent.spawn (the spawn's cwd, a pending isolation, or the lead's own) and
// moved by the agent's own writes and `cd`s, never by its reads. The git
// lookup runs off the call: `settle()` lets it land.
// ---------------------------------------------------------------------------

/** Lets the work a hook left running unawaited (the place lookup) settle: every fake here answers without a timer. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise<void>((done) => setImmediate(done));
}

/** A lead on `/repo/app` (main) with a sibling worktree `/repo/app-feature` (feature/login). */
function seedWorktrees(host: FakeHost): void {
  host.root = "/repo/app";
  for (const dir of ["/repo/app", "/repo/app/src"]) host.gitRepos.set(dir, { toplevel: "/repo/app", branch: "main" });
  for (const dir of ["/repo/app-feature", "/repo/app-feature/src"]) host.gitRepos.set(dir, { toplevel: "/repo/app-feature", branch: "feature/login" });
}

/** One tool call through the hook, in `agentId`'s loop (the main one when undefined); returns what the call resolved to and how many times `next` ran, with what. */
async function agentToolCall(handlers: Map<string, Hook>, engine: unknown, agentId: string | undefined, tool: string, args: Record<string, unknown>, toolUseId = "toolu_c"): Promise<{ result: unknown; nexts: unknown[] }> {
  const hook = handlers.get("tool.call");
  assert.ok(hook, "tool.call was never registered");
  const nexts: unknown[] = [];
  const event = { ...args, tool, tool_use_id: toolUseId, ...(agentId === undefined ? {} : { agentId }) };
  const result = await hook(engine, event, async (e: unknown) => {
    nexts.push(e);
    return { result: "ok" };
  });
  return { result, nexts };
}

function placeOf(host: FakeHost, agentId: string): StoredSubagent["place"] {
  return storedSubagents(host).find((agent) => agent.id === agentId)?.place;
}

test("0.6.23 T1: a spawn with no cwd works where the lead does", async () => {
  const host = makeFakeHost();
  seedWorktrees(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await spawnAs(handlers, engine, spawnEvent(), "agent-1");
  await settle();
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: "app", branch: "main", apart: false });
});

test("0.6.23 T1: a spawn with a cwd in another worktree works apart, on that worktree's branch", async () => {
  const host = makeFakeHost();
  seedWorktrees(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await spawnAs(handlers, engine, spawnEvent({ cwd: "/repo/app-feature" }), "agent-1");
  await settle();
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: "app-feature", branch: "feature/login", apart: true });
});

test("0.6.23 T1: a spawn outside any repository gets no place", async () => {
  const host = makeFakeHost();
  host.root = "/repo/plain";
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await spawnAs(handlers, engine, spawnEvent(), "agent-1");
  await settle();
  assert.equal(placeOf(host, "agent-1"), undefined);
  assert.equal(storedSubagents(host).length, 1, "the row itself stands");
});

test("0.6.23 T1: an Agent call asking for a worktree is pending until the agent's own write shows where", async () => {
  const host = makeFakeHost();
  seedWorktrees(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await agentToolCall(handlers, engine, undefined, "Agent", { description: "List files", prompt: "p", isolation: "worktree" }, "toolu_iso");
  await spawnAs(handlers, engine, spawnEvent({ tool_use_id: "toolu_iso" }), "agent-1");
  await settle();
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: null, branch: null, apart: true, pendingIsolation: true });
  host.agents = [{ id: "agent-1", status: "running", type: "general-purpose", description: "List files" }];
  await agentToolCall(handlers, engine, "agent-1", "Edit", { file_path: "/repo/app-feature/src/login.ts", old_string: "a", new_string: "b" });
  await settle();
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: "app-feature", branch: "feature/login", apart: true });
});

test("0.6.23 T1: an agent's `cd` moves it, its reads never do, and a directory runs git once", async () => {
  const host = makeFakeHost();
  seedWorktrees(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await spawnAs(handlers, engine, spawnEvent(), "agent-1");
  await settle();
  await agentToolCall(handlers, engine, "agent-1", "Read", { file_path: "/repo/app-feature/odd/plan.md" });
  await agentToolCall(handlers, engine, "agent-1", "Grep", { pattern: "x", path: "/repo/app-feature" });
  await settle();
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: "app", branch: "main", apart: false }, "reading a sibling worktree does not move it");
  await agentToolCall(handlers, engine, "agent-1", "Bash", { command: "cd /repo/app-feature && npm test" });
  await settle();
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: "app-feature", branch: "feature/login", apart: true });
  const gitCalls = (): number => host.processCalls.filter((call) => call.startsWith("git -C /repo/app-feature ")).length;
  const before = gitCalls();
  await agentToolCall(handlers, engine, "agent-1", "Bash", { command: "cd /repo/app-feature && git status" });
  await agentToolCall(handlers, engine, "agent-1", "Bash", { command: "cd /repo/app && ls" });
  await agentToolCall(handlers, engine, "agent-1", "Bash", { command: "cd /repo/app-feature" });
  await settle();
  assert.equal(gitCalls(), before, "a directory seen before is not looked up again");
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: "app-feature", branch: "feature/login", apart: true });
});

test("0.6.23 T1: a call in no recorded agent's loop, or the lead's own, sets no place", async () => {
  const host = makeFakeHost();
  seedWorktrees(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await agentToolCall(handlers, engine, "agent-9", "Bash", { command: "cd /repo/app-feature" });
  await agentToolCall(handlers, engine, undefined, "Bash", { command: "cd /repo/app-feature" });
  await settle();
  assert.deepEqual(storedSubagents(host), []);
});

test("0.6.23 T1: the call goes through exactly once, unchanged, and a failing lookup never fails it", async () => {
  const host = makeFakeHost();
  seedWorktrees(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await spawnAs(handlers, engine, spawnEvent(), "agent-1");
  await settle();
  host.failProcess = true;
  const args = { command: "cd /repo/app-feature && npm test" };
  const { result, nexts } = await agentToolCall(handlers, engine, "agent-1", "Bash", args);
  await settle();
  assert.deepEqual(result, { result: "ok" });
  assert.deepEqual(nexts, [{ ...args, tool: "Bash", tool_use_id: "toolu_c", agentId: "agent-1" }]);
  assert.deepEqual(placeOf(host, "agent-1"), { worktree: "app", branch: "main", apart: false }, "an unknown place keeps the last known one");
});

test("0.6.23 T1: drawing the band never runs git", async () => {
  const host = makeFakeHost();
  seedWorktrees(host);
  const { handlers, engine } = loadHooksWith(host, { routerMode: "off" });
  await spawnAs(handlers, engine, spawnEvent({ cwd: "/repo/app-feature" }), "agent-1");
  await settle();
  host.agents = [{ id: "agent-1", status: "running", type: "general-purpose", description: "List files" }];
  const before = host.processCalls.length;
  await renderBand(handlers, engine, 200);
  await renderBand(handlers, engine, 80);
  await settle();
  assert.equal(host.processCalls.length, before);
});

// ---------------------------------------------------------------------------
// Feature modules (odd/tasks/feature-modules.md, T4): each mod feature reads
// `<configDir>/feature-modules.json` on every hook call. `off` returns before
// any Jev call and any side effect; `shadow` is the feature's measure mode;
// a missing or corrupt file is exactly the behaviour without the file.
// ---------------------------------------------------------------------------

const FEATURE_MODULES_PATH = `${CONFIG_DIR}/feature-modules.json`;

function setModules(host: FakeHost, modules: Record<string, string>): void {
  host.files.set(FEATURE_MODULES_PATH, JSON.stringify({ modules }));
}

/** What a hook left behind: every file written and every state key set, apart from what the test seeded. */
function leftBehind(host: FakeHost, seededFiles: ReadonlySet<string>): string[] {
  return [...[...host.files.keys()].filter((path) => !seededFiles.has(path)), ...[...host.state.keys()].map((key) => `state:${key}`)];
}

const SKILL_PICK_ANSWERS = (): unknown[] => [
  jevResponse({
    which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.9 }, confidence: 0.9 },
    skill_needed: { type: "noul", noul: 0.8 },
  }),
  jevResponse({
    which: { type: "choice", choice: "graft-helper", probabilities: { "graft-helper": 0.95 }, confidence: 0.9 },
    "fits::graft-helper": { type: "noul", noul: 0.9 },
  }),
];

function seedSkillSelection(host: FakeHost): void {
  seedModSkillsConfig(host, { active: true, activeTools: true });
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 100 });
  seedProjectSkill(host, "graft-helper", "Explores this codebase with graft.", "Read graft_repo_map first.");
  host.toolList = [{ name: "Bash", description: "Runs a shell command", mcp: false }];
}

test("T4 skill-selection off: a prompt makes no Jev call, injects nothing, writes nothing and keeps the listing", async () => {
  const host = makeFakeHost();
  seedSkillSelection(host);
  setModules(host, { "skill-selection": "off" });
  host.fetchQueue.push(...SKILL_PICK_ANSWERS());
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooks(host);

  const event = await submitPromptCapture(handlers, engine, "how does the auth module work");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.equal(host.fetchCalls.length, 0, "no Jev call");
  assert.equal(event.context, undefined, "nothing injected");
  assert.deepEqual(attachment, { text: REAL_LISTING });
  assert.equal(host.processCalls.length, 0, "no orca lookup for a feature that is off");
  assert.deepEqual(leftBehind(host, seeded).filter((entry) => !entry.startsWith("state:")), [], "no measurement file");
});

test("T4 skill-selection off: a skill or tool the model loads is not observed", async () => {
  const host = makeFakeHost();
  seedSkillSelection(host);
  host.fetchQueue.push(...SKILL_PICK_ANSWERS());
  const { handlers, engine } = loadHooks(host);
  await submitPrompt(handlers, engine, "how does the auth module work");
  const before = host.files.get(SKILL_MEASUREMENTS_PATH);
  assert.ok(before, "the decision was measured while the module was on");

  setModules(host, { "skill-selection": "off" });
  await fireSkillPrompt(handlers, engine, "graft-helper");
  await toolCallThrough(handlers, engine, "Bash", { command: "ls" }, { result: "ok" });

  assert.equal(host.files.get(SKILL_MEASUREMENTS_PATH), before, "no observation row once the module is off");
  assert.doesNotMatch(host.files.get(TOOL_MEASUREMENTS_PATH) ?? "", /"type":"observation"/);
});

test("T4 skill-selection shadow: the active switches run as measurement -- Jev is asked, nothing is injected or withheld", async () => {
  const host = makeFakeHost();
  seedSkillSelection(host);
  host.toolList = [];
  setModules(host, { "skill-selection": "shadow" });
  host.fetchQueue.push(...SKILL_PICK_ANSWERS());
  const { handlers, engine } = loadHooks(host);

  const event = await submitPromptCapture(handlers, engine, "how does the auth module work");
  const attachment = await askAttachment(handlers, engine, REAL_LISTING);

  assert.equal(host.fetchCalls.length, 2, "measurement mode asks both stages");
  assert.equal(event.context, undefined, "nothing injected");
  assert.deepEqual(attachment, { text: REAL_LISTING }, "the listing is delivered");
  const record = lastDecisionRecord(host, SKILL_MEASUREMENTS_PATH);
  assert.equal(record.mode, "measurement");
  assert.equal(record.listingWithheld, false);
});

test("T4 skill-selection active, and a missing or corrupt module file: exactly today's behaviour", async () => {
  for (const content of [undefined, "{ not json", JSON.stringify({ modules: { "skill-selection": "banana" } })]) {
    const host = makeFakeHost();
    seedSkillSelection(host);
    host.toolList = [];
    if (content !== undefined) host.files.set(FEATURE_MODULES_PATH, content);
    host.fetchQueue.push(...SKILL_PICK_ANSWERS());
    const { handlers, engine } = loadHooks(host);
    const event = await submitPromptCapture(handlers, engine, "how does the auth module work");
    const attachment = await askAttachment(handlers, engine, REAL_LISTING);
    assert.equal(host.fetchCalls.length, 2, `${content ?? "no file"}: both stages ran`);
    assert.equal(event.context?.length, 1, `${content ?? "no file"}: the skill is injected`);
    assert.equal(attachment.text, null, `${content ?? "no file"}: the listing is withheld`);
  }
});

test("T4 skill-selection: a switch in the file is picked up by the loaded hooks, in both directions, with no reload", async () => {
  const host = makeFakeHost();
  seedSkillSelection(host);
  host.toolList = [];
  const { handlers, engine } = loadHooks(host);

  host.fetchQueue.push(...SKILL_PICK_ANSWERS());
  await submitPrompt(handlers, engine, "first prompt");
  assert.equal(host.fetchCalls.length, 2, "on by default");

  setModules(host, { "skill-selection": "off" });
  host.fetchQueue.push(...SKILL_PICK_ANSWERS());
  await submitPrompt(handlers, engine, "second prompt");
  assert.equal(host.fetchCalls.length, 2, "off: no further call");

  setModules(host, { "skill-selection": "active" });
  await submitPrompt(handlers, engine, "third prompt");
  assert.equal(host.fetchCalls.length, 4, "on again: asked again");
});

test("T4 model-router off: a main step is passed through -- no Jev call, no router log, no usage line, no state", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  setModules(host, { "model-router": "off" });
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);

  assert.equal(host.fetchCalls.length, 0);
  assert.deepEqual(leftBehind(host, seeded), [], "no usage line, no decision, no sticky state");
});

test("T4 model-router off: a prompt's origin is not stamped", async () => {
  const host = makeFakeHost();
  setModules(host, { "model-router": "off" });
  const { handlers, engine } = loadHooks(host);
  await submitOrigin(handlers, engine, "user");
  assert.equal(host.state.has("routerPromptOrigin"), false);
});

test("T4 model-router on: a prompt's origin is stamped, as before", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  await submitOrigin(handlers, engine, "user");
  assert.equal(host.state.has("routerPromptOrigin"), true);
});

test("T4 model-router off: a subagent spawn is passed through -- no Jev call, no row, no state, no status", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  setModules(host, { "model-router": "off" });
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  const event = spawnEvent();
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  await startSession(handlers, engine);
  await completeSubagent(handlers, engine, "agent-1");
  host.agents = [{ id: "agent-1", status: "running", type: "general-purpose", description: "List files" }];

  assert.equal(host.fetchCalls.length, 0);
  assert.deepEqual(leftBehind(host, seeded), []);
  assert.deepEqual(host.statusLines, [], "no status line");
  assert.deepEqual(await renderBand(handlers, engine), ENGINE_DRAWING, "no band");
});

test("T4 model-router off: a teammate's step and the lead's Agent call are neither routed nor remembered", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  setModules(host, { "model-router": "off" });
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  await leadCallsTeammate(handlers, engine);
  host.agents = [TEAMMATE];
  const event = teammateStep(0);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);

  assert.equal(host.fetchCalls.length, 0);
  assert.deepEqual(leftBehind(host, seeded), []);
});

test("T4 model-router shadow: an active router only measures -- the decision is logged, nothing sent changes", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
  setModules(host, { "model-router": "shadow" });
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });

  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event, "the step is sent as it came");
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.proposed, "claude-haiku-4-5-20251001");
  assert.equal(decision?.applied, false);
  assert.equal(lastTurnUsageLine(host).agent, "main", "the usage line is still written");

  const spawn = spawnEvent();
  assert.deepEqual(await spawnThrough(handlers, engine, spawn), spawn, "a subagent keeps the model it asked for");
});

test("T4 model-router shadow: the work kind only measures too", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.files.set(`${ACCOUNT_DIR}/settings.json`, JSON.stringify({ env: {}, pluginConfigs: { "orca-jev-mod-skills@skills-dir": { options: { workKindMode: "active" } } } }));
  host.fetchQueue.push(tierAnswer("standard"));
  setModules(host, { "model-router": "shadow" });
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent());
  await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "high" }));
  const row = routerDecisionLines(host)[0] as { workKind?: { mode: string; applied: boolean } } | undefined;
  assert.equal(row?.workKind?.mode, "measure");
  assert.equal(row?.workKind?.applied, false);
});

test("T4 model-router: a switch in the file is picked up by the loaded hooks, in both directions, with no reload", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "hi, what time is it?", toolUses: [] }];
  const { handlers, engine } = loadHooksWith(host, { routerMode: "measure" });

  setModules(host, { "model-router": "off" });
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(host.files.has(TURN_USAGE_PATH), false);

  setModules(host, { "model-router": "active" });
  host.fetchQueue.push(tierAnswer("simple"));
  await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(host.fetchCalls.length, 1);
  assert.equal(host.files.has(TURN_USAGE_PATH), true);
});

// ---------------------------------------------------------------------------
// Verify the "done" (odd/tasks/verify-done-module.md, V3): after a main-loop
// turn that ended with an answer, a timer asks Jev once whether the final
// message claims the work is done, only when the turn edited files and no
// test passed, and writes one row. Shadow only: the turn's result is never
// touched. The pure rules are covered in src/core/verify_done.test.ts.
// ---------------------------------------------------------------------------

const VERIFY_DONE_PATH = `${CACHE_DIR}/verify-done-decisions-2026-09-25T10.jsonl`;
/** What `next(e)` resolves to in these tests: the hook must hand back this very object. */
const TURN_RESULT = { text: "Done: the parser is fixed." };


const EDIT_ONLY: Row[] = [
  { role: "user", text: "fix the parser", toolUses: [] },
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "e1", tool: "Edit", input: { file_path: "src/parser.ts", old_string: "a", new_string: "b" } }] },
];
const EDIT_AND_GREEN: Row[] = [...EDIT_ONLY, { role: "assistant", text: "", toolUses: [{ tool_use_id: "t1", tool: "Bash", input: { command: "npm test" }, text: "ℹ pass 12\nℹ fail 0" }] }];
const EDIT_AND_RED: Row[] = [...EDIT_ONLY, { role: "assistant", text: "", toolUses: [{ tool_use_id: "t1", tool: "Bash", input: { command: "npm test" }, text: "ℹ pass 11\nℹ fail 1" }] }];
const NO_EDIT: Row[] = [
  { role: "user", text: "how does the parser work", toolUses: [] },
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "r1", tool: "Read", input: { file_path: "src/parser.ts" }, text: "export function parse() {}" }] },
];

function claimAnswer(choice: string, confidence: number): unknown {
  return jevResponse({ claim: { type: "choice", choice, probabilities: {}, confidence } });
}

/** Fires turn.complete and returns what the hook handed back. */
async function completeTurn(handlers: Map<string, Hook>, engine: unknown, extra: Record<string, unknown> = {}): Promise<unknown> {
  const hook = handlers.get("turn.complete");
  assert.ok(hook, "turn.complete was never registered");
  return hook(engine, { answer: "Done: the parser is fixed.", durationMs: 10, isAborted: false, turnId: "turn-1", reason: "answer", ...extra }, async () => TURN_RESULT);
}

async function runTimers(host: FakeHost): Promise<void> {
  while (host.timers.length > 0) {
    const due = host.timers;
    host.timers = [];
    for (const fn of due) await fn();
  }
}

function verifyDoneRows(host: FakeHost): Record<string, unknown>[] {
  return (host.files.get(VERIFY_DONE_PATH) ?? "").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The Jev calls verify-done made: the ones whose body asks the `claim` question. */
function claimCalls(host: FakeHost): { url: string; body?: string }[] {
  return host.fetchCalls.filter((call) => (call.body ?? "").includes('"claim"'));
}

test("V3 verify-done shadow (the default, no module file): a candidate turn asks Jev exactly once and writes one row; the turn's result is unchanged", async () => {
  const host = makeFakeHost();
  host.messages = EDIT_ONLY;
  host.fetchQueue.push(claimAnswer("claimed-done", 0.9));
  const { handlers, engine } = loadHooks(host);

  const result = await completeTurn(handlers, engine);
  assert.equal(result, TURN_RESULT, "next(e)'s result is handed back as it was");
  await runTimers(host);

  assert.equal(host.fetchCalls.length, 1, "one Jev call in all");
  assert.equal(claimCalls(host).length, 1);
  const rows = verifyDoneRows(host);
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0]?.latencyMs, "number", "the call's latency, for measure-module-cost's p50/p90");
  assert.deepEqual({ ...rows[0], at: "x", account: "x", latencyMs: "x" }, {
    at: "x",
    account: "x",
    latencyMs: "x",
    project: "sandbox",
    mode: "shadow",
    sessionId: "session-1",
    decision: "would-block",
    claim: "claimed-done",
    confidence: 0.9,
    wouldBlock: true,
    filesEdited: 1,
    testsRun: 0,
    testsPassed: null,
  });
});

test("V3 verify-done shadow: a failing test still makes the turn a candidate", async () => {
  const host = makeFakeHost();
  host.messages = EDIT_AND_RED;
  host.fetchQueue.push(claimAnswer("not-claimed", 0.8));
  const { handlers, engine } = loadHooks(host);
  await completeTurn(handlers, engine);
  await runTimers(host);
  assert.equal(claimCalls(host).length, 1);
  assert.equal(verifyDoneRows(host)[0]?.decision, "not-claimed");
  assert.equal(verifyDoneRows(host)[0]?.testsPassed, false);
});

test("V3 verify-done shadow: a turn with no edit, or with its tests passing, makes no Jev call and writes no row", async () => {
  for (const messages of [NO_EDIT, EDIT_AND_GREEN]) {
    const host = makeFakeHost();
    host.messages = messages;
    // Queued so that a wrong call is counted instead of failing on an empty queue.
    host.fetchQueue.push(claimAnswer("claimed-done", 0.9));
    const { handlers, engine } = loadHooks(host);
    const result = await completeTurn(handlers, engine);
    await runTimers(host);
    assert.equal(result, TURN_RESULT);
    assert.equal(host.fetchCalls.length, 0, "no Jev call");
    assert.equal(host.files.has(VERIFY_DONE_PATH), false, "no row");
  }
});

test("V3 verify-done off: a candidate turn makes no Jev call and writes nothing; the turn's result is unchanged", async () => {
  const host = makeFakeHost();
  setModules(host, { "verify-done": "off" });
  host.messages = EDIT_ONLY;
  host.fetchQueue.push(claimAnswer("claimed-done", 0.9));
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooks(host);

  const result = await completeTurn(handlers, engine);
  await runTimers(host);

  assert.equal(result, TURN_RESULT);
  assert.equal(host.fetchCalls.length, 0, "no Jev call");
  assert.deepEqual(leftBehind(host, seeded).filter((entry) => entry.includes("verify-done")), [], "no row");
});

test("V3 verify-done: a timer already scheduled asks nothing once the module went off", async () => {
  const host = makeFakeHost();
  host.messages = EDIT_ONLY;
  host.fetchQueue.push(claimAnswer("claimed-done", 0.9));
  const { handlers, engine } = loadHooks(host);
  await completeTurn(handlers, engine);
  assert.ok(host.timers.length > 0, "scheduled while the module was on");

  setModules(host, { "verify-done": "off" });
  await runTimers(host);
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(host.files.has(VERIFY_DONE_PATH), false);
});

test("V3 verify-done: a subagent's turn and a turn that did not end with an answer do nothing", async () => {
  for (const extra of [{ agentId: "a-1" }, { reason: "aborted", isAborted: true }, { reason: "error" }, { reason: "refusal", refusal: { category: null, explanation: null } }]) {
    const host = makeFakeHost();
    host.messages = EDIT_ONLY;
    host.fetchQueue.push(claimAnswer("claimed-done", 0.9));
    const { handlers, engine } = loadHooks(host);
    const result = await completeTurn(handlers, engine, extra);
    await runTimers(host);
    assert.equal(result, TURN_RESULT, JSON.stringify(extra));
    assert.equal(host.fetchCalls.length, 0, JSON.stringify(extra));
    assert.equal(host.files.has(VERIFY_DONE_PATH), false, JSON.stringify(extra));
  }
});

test("V3 verify-done: a Jev failure writes a jev-failed row and the turn ends as it would have", async () => {
  const host = makeFakeHost();
  host.messages = EDIT_ONLY;
  // A body that is not a Jev response: a failure, never a guess.
  host.fetchQueue.push("not a jev response");
  const { handlers, engine } = loadHooks(host);
  const result = await completeTurn(handlers, engine);
  await runTimers(host);
  assert.equal(result, TURN_RESULT);
  assert.equal(host.fetchCalls.length, 1);
  const rows = verifyDoneRows(host);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "jev-failed");
  assert.equal(rows[0]?.claim, null);
  assert.equal(rows[0]?.confidence, null);
  assert.equal(rows[0]?.wouldBlock, false);
});

test("V3 verify-done: what Jev reads is the redacted final message and counts; a secret, a path or file contents never reach the call", async () => {
  const host = makeFakeHost();
  const secret = "sk-ant-api03-" + "b".repeat(40);
  host.messages = [
    { role: "user", text: "fix the parser", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "e1", tool: "Write", input: { file_path: "src/secret-module.ts", content: "const SECRET_CONTENTS = 1" } }] },
  ];
  host.fetchQueue.push(claimAnswer("claimed-done", 0.9));
  const { handlers, engine } = loadHooks(host);
  await completeTurn(handlers, engine, { answer: `Done, wired the key ${secret} into the parser.` });
  await runTimers(host);
  const body = claimCalls(host)[0]?.body ?? "";
  assert.ok(body.includes("Done, wired the key"), "the message is sent");
  assert.ok(!body.includes(secret), "the secret is redacted");
  assert.ok(!body.includes("SECRET_CONTENTS"), "no file contents");
  assert.ok(!body.includes("secret-module"), "no paths");
});

// ---------------------------------------------------------------------------
// K0b typing lead time (odd/tasks/typing-lead-time.md): `prompt.edit` keeps
// each session's draft in memory only; `prompt.submit` writes one row per
// scored prompt to `typing-<hour>.jsonl`, following skill-selection's state.
// These tests load the real mod, so they also prove it loads with the new
// src/core import (src/core/typing_lead_time.ts has no `node:` import).
// ---------------------------------------------------------------------------

const TYPING_PATH = `${CACHE_DIR}/typing-2026-09-25T10.jsonl`;
const EDIT_RESULT = { text: "h", cursor: 1 };

/** One keystroke at the composer; returns what the hook handed back. */
async function typeKey(handlers: Map<string, Hook>, engine: unknown, text = ""): Promise<unknown> {
  const hook = handlers.get("prompt.edit");
  assert.ok(hook, "prompt.edit was never registered");
  return hook(engine, { origin: { kind: "composer" }, text, cursor: text.length, start: text.length, end: text.length, inputText: "h" }, async () => EDIT_RESULT);
}

async function submitFrom(handlers: Map<string, Hook>, engine: unknown, text: string, kind: string): Promise<unknown> {
  const submit = handlers.get("prompt.submit");
  assert.ok(submit, "prompt.submit was never registered");
  return submit(engine, { text, wait: false, origin: { kind } }, promptSubmitNext);
}

function typingRows(host: FakeHost): Record<string, unknown>[] {
  return (host.files.get(TYPING_PATH) ?? "").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("K0b the installed mod carries the typing core, and nothing it loads imports node: (the hook sandbox has no Node)", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const closure = await walkModSkillsClosure("adapters/claude/mod-skills/hooks/index.ts", { read: (path) => readFile(join(repoRoot, path), "utf8") });
  assert.ok(closure.includes("src/core/typing_lead_time.ts"), "the install copies the new core file");
  for (const path of closure) {
    const source = await readFile(join(repoRoot, path), "utf8");
    assert.doesNotMatch(source, /from ["']node:/, path);
  }
});

test("K0b prompt.edit: hands back next(e)'s own result and writes no file and no state, keystroke after keystroke", async () => {
  const host = makeFakeHost();
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooks(host);
  for (let i = 0; i < 5; i += 1) assert.equal(await typeKey(handlers, engine, "h".repeat(i)), EDIT_RESULT);
  assert.deepEqual(leftBehind(host, seeded), []);
  assert.equal(host.fetchCalls.length, 0);
});

test("K0b prompt.edit: a failing clock or session read never reaches the keystroke or the prompt", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  const base = engine as Record<string, Record<string, unknown>>;
  const broken = { ...base, clock: { ...base.clock, now: async () => { throw new Error("fake host: clock failed"); } }, session: { ...base.session, id: async () => { throw new Error("fake host: id failed"); } } };
  assert.equal(await typeKey(handlers, broken), EDIT_RESULT);
  const submitted = await submitFrom(handlers, broken, "how does the auth module work", "composer");
  assert.deepEqual(submitted, { text: "how does the auth module work", wait: false, origin: { kind: "composer" } });
});

test("K0b composer prompt: one row with the gap since the last edit and the number of edits", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  for (let i = 0; i < 4; i += 1) await typeKey(handlers, engine, "h".repeat(i));
  // The person pauses: the queued keystroke updates run, then 750 ms pass.
  await new Promise<void>((resolve) => setImmediate(resolve));
  host.clockOffsetMs = 750;
  await submitFrom(handlers, engine, "how does the auth module work", "composer");
  const rows = typingRows(host);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row?.type, "typing");
  assert.equal(row?.kind, "composer");
  assert.equal(row?.origin, "composer");
  assert.equal(row?.edits, 4);
  assert.equal(row?.sessionId, "session-1");
  assert.ok(typeof row?.gapMs === "number" && row.gapMs >= 750 && row.gapMs < 800, `gap ${String(row?.gapMs)}`);
  assert.equal(JSON.stringify(row).includes("auth module"), false, "the prompt's text is never logged");
});

test("K0b the draft is cleared at submit: the next prompt counts only its own edits", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  for (let i = 0; i < 3; i += 1) await typeKey(handlers, engine);
  await submitFrom(handlers, engine, "first prompt", "composer");
  await typeKey(handlers, engine);
  await submitFrom(handlers, engine, "second prompt", "composer");
  assert.deepEqual(typingRows(host).map((row) => row.edits), [3, 1]);
});

test("K0b injected prompt: a row of kind injected with no gap, and the draft being typed is left for its own submit", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  await typeKey(handlers, engine);
  await typeKey(handlers, engine);
  await submitFrom(handlers, engine, "a background task finished", "task-notification");
  await submitFrom(handlers, engine, "my own prompt", "composer");
  const rows = typingRows(host);
  assert.deepEqual(rows.map((row) => [row.kind, row.origin, row.gapMs === null, row.edits]), [["injected", "task-notification", true, 0], ["composer", "composer", false, 2]]);
});

test("K0b a composer prompt with no edit seen is injected, never a 0 ms gap", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  await submitFrom(handlers, engine, "how does the auth module work", "composer");
  const [row] = typingRows(host);
  assert.equal(row?.kind, "injected");
  assert.equal(row?.gapMs, null);
});

test("K0b empty prompts and slash commands are not scored, so they write no row and still clear the draft", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  await typeKey(handlers, engine);
  await submitFrom(handlers, engine, "/clear", "composer");
  await submitFrom(handlers, engine, "   ", "composer");
  assert.equal(host.files.has(TYPING_PATH), false);
  await submitFrom(handlers, engine, "a real prompt", "composer");
  assert.equal(typingRows(host)[0]?.kind, "injected", "the /clear draft is not carried over");
});

test("K0b skill-selection off: typing and sending writes no row", async () => {
  const host = makeFakeHost();
  setModules(host, { "skill-selection": "off" });
  const { handlers, engine } = loadHooks(host);
  await typeKey(handlers, engine);
  await submitFrom(handlers, engine, "how does the auth module work", "composer");
  await submitFrom(handlers, engine, "a background task finished", "task-notification");
  assert.equal(host.files.has(TYPING_PATH), false);
});

test("K0b skill-selection shadow: rows are written as in active", async () => {
  const host = makeFakeHost();
  setModules(host, { "skill-selection": "shadow" });
  const { handlers, engine } = loadHooks(host);
  await typeKey(handlers, engine);
  await submitFrom(handlers, engine, "how does the auth module work", "composer");
  assert.equal(typingRows(host).length, 1);
});

test("K0b a subagent's run writes no typing row and leaves the person's draft alone", async () => {
  const host = makeFakeHost();
  setModules(host, { "model-router": "off" });
  const { handlers, engine } = loadHooks(host);
  await typeKey(handlers, engine);
  await spawnThrough(handlers, engine, spawnEvent());
  await completeTurn(handlers, engine, { agentId: "agent-1" });
  assert.equal(host.files.has(TYPING_PATH), false);
  await submitFrom(handlers, engine, "my own prompt", "composer");
  assert.deepEqual(typingRows(host).map((row) => [row.kind, row.edits]), [["composer", 1]]);
});

// ---------------------------------------------------------------------------
// The CI watcher (odd/tasks/ci-watcher.md). C2: a push, a pull request or a
// merge in the MAIN thread starts a watch, after `next`, on a timer, and the
// call's result is never touched. The pure rules are covered in
// src/core/ci_watch.test.ts.
// ---------------------------------------------------------------------------

const CI_SHA = "0123456789abcdef0123456789abcdef01234567";
const CI_MERGE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const CI_LOG_PATH = `${CACHE_DIR}/ci-watch-decisions-2026-09-25T10.jsonl`;
const OK = (stdout: string): { exitCode: number; stdout: string; stderr: string } => ({ exitCode: 0, stdout, stderr: "" });
const FAILED = { exitCode: 1, stdout: "", stderr: "fatal" };

interface CiRepoScript {
  /** git's top level for any directory; null answers "not a repository". */
  toplevel: string | null;
  sha: string;
  /** What `git branch --show-current` answers (empty on a detached HEAD). */
  branch: string;
  /** `gh pr view` answers, in order; the last repeats. */
  prView: string[];
  /** `gh run list` answers, in order; the last repeats: the runs gh prints, "fail" for a non-zero exit, "missing" for a gh that cannot start. */
  polls: (Record<string, unknown>[] | "fail" | "missing")[];
  /** `gh run list --workflow <name> --status success` answers (the usual-time lookup); same forms as `polls`, one answer repeated. */
  history: Record<string, unknown>[] | "fail" | "missing";
}

/** Answers git for a repository: its top level, the sha of any ref and the branch checked out; `gh pr view` from `script.prView` and `gh run list` from `script.polls`. */
function seedCiRepo(host: FakeHost, script: Partial<CiRepoScript> = {}): CiRepoScript {
  const repo: CiRepoScript = { toplevel: CWD, sha: CI_SHA, branch: "feat/x", prView: [], polls: [], history: [], ...script };
  const prViews = [...repo.prView];
  const polls = [...repo.polls];
  const previous = host.processHandler;
  host.processHandler = (argv, init) => {
    if (argv[0] === "git" && argv[1] === "-C") {
      const rest = argv.slice(3);
      if (rest[0] === "rev-parse" && rest[1] === "--show-toplevel") return repo.toplevel === null ? FAILED : OK(`${repo.toplevel}\n`);
      if (rest[0] === "rev-parse") return OK(`${repo.sha}\n`);
      if (rest[0] === "branch") return OK(`${repo.branch}\n`);
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return OK(prViews.length > 1 ? (prViews.shift() ?? "") : (prViews[0] ?? ""));
    if (argv[0] === "gh" && argv[1] === "run" && argv[2] === "list" && argv.includes("--workflow")) {
      if (repo.history === "missing") throw new Error("fake host: gh cannot start");
      return repo.history === "fail" ? FAILED : OK(JSON.stringify(repo.history));
    }
    if (argv[0] === "gh" && argv[1] === "run" && argv[2] === "list") {
      const answer = polls.length > 1 ? polls.shift() : polls[0];
      if (answer === "missing") throw new Error("fake host: gh cannot start");
      if (answer === "fail") return FAILED;
      return OK(JSON.stringify(answer ?? []));
    }
    return previous?.(argv, init);
  };
  return repo;
}

/** A Bash outcome as core resolves it: `{ result, text }`, with the engine's own gitOperation when given. */
function bashOutcome(text: string, gitOperation?: Record<string, unknown>, isError = false): Record<string, unknown> {
  return { ref: 1, result: { stdout: text, stderr: "", interrupted: false, ...(gitOperation === undefined ? {} : { gitOperation }) }, text, ...(isError ? { isError: true } : {}) };
}

/** One Bash `tool.call` through the hook; returns what the hook handed back and how often `next` ran. */
async function bashThrough(handlers: Map<string, Hook>, engine: unknown, command: string, outcome: Record<string, unknown>, agentId?: string): Promise<{ returned: unknown; nexts: number }> {
  const hook = handlers.get("tool.call");
  assert.ok(hook, "tool.call was never registered");
  let nexts = 0;
  const returned = await hook(engine, { command, tool: "Bash", tool_use_id: `toolu_${command.length}`, ...(agentId === undefined ? {} : { agentId }) }, async () => {
    nexts += 1;
    return outcome;
  });
  return { returned, nexts };
}

function gitCalls(host: FakeHost): string[] {
  return host.processCalls.filter((call) => call.startsWith("git "));
}

test("C2 ci-watch: a push in the main thread is resolved on a timer, after next; the call's result is the one next gave", async () => {
  const host = makeFakeHost();
  seedCiRepo(host);
  const { handlers, engine } = loadHooks(host);
  const outcome = bashOutcome("To github.com:a/b.git\n   abc..def  feat/x -> feat/x", { push: { branch: "feat/x" } });

  const { returned, nexts } = await bashThrough(handlers, engine, "git push -u origin feat/x", outcome);
  assert.equal(returned, outcome, "the very object next resolved to");
  assert.equal(nexts, 1);
  assert.deepEqual(host.processCalls, [], "nothing runs inside the call");
  assert.equal(host.timers.length, 1, "one timer carries the start");

  await runTimers(host);
  // The branch is the engine's, so git is asked for its sha and the repository, not for the branch.
  assert.deepEqual(gitCalls(host), [`git -C ${CWD} rev-parse --show-toplevel`, `git -C ${CWD} rev-parse --verify feat/x^{commit}`]);
});

test("C2 ci-watch: a push that names no branch is resolved from HEAD and the branch checked out", async () => {
  const host = makeFakeHost();
  seedCiRepo(host);
  const { handlers, engine } = loadHooks(host);
  await bashThrough(handlers, engine, "git push", bashOutcome("pushed"));
  await runTimers(host);
  assert.deepEqual(gitCalls(host), [`git -C ${CWD} rev-parse --show-toplevel`, `git -C ${CWD} rev-parse --verify HEAD^{commit}`, `git -C ${CWD} branch --show-current`]);
});

test("C2 ci-watch: the repository asked is the one the command ran in (cd and git -C)", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { toplevel: "/home/dev/Projects/other" });
  const { handlers, engine } = loadHooks(host);
  await bashThrough(handlers, engine, "cd /home/dev/Projects/other && git push origin feat/x", bashOutcome("pushed"));
  await runTimers(host);
  assert.ok(gitCalls(host).length >= 2, "the repository was looked up");
  assert.ok(gitCalls(host).every((call) => call.startsWith("git -C /home/dev/Projects/other ")), gitCalls(host).join("\n"));
});

test("C2 ci-watch: what starts nothing - a subagent's push, a failed or dry or empty push, any other command, a merge only queued", async () => {
  const cases: { name: string; command: string; outcome: Record<string, unknown>; agentId?: string }[] = [
    { name: "a subagent's push", command: "git push", outcome: bashOutcome("pushed", { push: { branch: "feat/x" } }), agentId: "agent-1" },
    { name: "a failed push", command: "git push", outcome: bashOutcome("rejected", undefined, true) },
    { name: "a dry run", command: "git push --dry-run", outcome: bashOutcome("would push") },
    { name: "a push that changed nothing", command: "git push", outcome: bashOutcome("Everything up-to-date") },
    { name: "another command", command: "ls -la", outcome: bashOutcome("files") },
    { name: "a merge queued for later", command: "gh pr merge 9 --auto", outcome: bashOutcome("auto-merge enabled", { pr: { number: 9, action: "auto-merge-enabled" } }) },
    { name: "a refused call", command: "git push", outcome: { deny: "blocked" } },
  ];
  for (const { name, command, outcome, agentId } of cases) {
    const host = makeFakeHost();
    seedCiRepo(host);
    const { handlers, engine } = loadHooks(host);
    const { returned } = await bashThrough(handlers, engine, command, outcome, agentId);
    assert.equal(returned, outcome, name);
    await runTimers(host);
    assert.deepEqual(host.processCalls, [], name);
    assert.equal(host.timers.length, 0, name);
  }
});

test("C2 ci-watch off: a push starts nothing - no timer, no process; the result is unchanged", async () => {
  const host = makeFakeHost();
  seedCiRepo(host);
  setModules(host, { "ci-watch": "off" });
  const { handlers, engine } = loadHooks(host);
  const outcome = bashOutcome("pushed", { push: { branch: "feat/x" } });
  const { returned } = await bashThrough(handlers, engine, "git push", outcome);
  assert.equal(returned, outcome);
  await runTimers(host);
  assert.deepEqual(host.processCalls, []);
  assert.equal(host.timerDelays.length, 0);
  assert.equal(host.state.size, 0, "no state written");
});

test("C2 ci-watch: a merged pull request asks gh for its merge commit; a merge with none yet starts nothing more", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { prView: [JSON.stringify({ mergeCommit: { oid: CI_MERGE_SHA }, baseRefName: "main" })] });
  const { handlers, engine } = loadHooks(host);
  await bashThrough(handlers, engine, "gh pr merge 53 --squash", bashOutcome("merged", { pr: { number: 53, action: "merged" } }));
  await runTimers(host);
  const view = host.processCalls.findIndex((call) => call.startsWith("gh pr view"));
  assert.equal(host.processCalls[view], "gh pr view 53 --json mergeCommit,baseRefName");
  assert.equal(host.processInits[view]?.cwd, CWD);
  assert.deepEqual(gitCalls(host), [`git -C ${CWD} rev-parse --show-toplevel`]);

  const queued = makeFakeHost();
  seedCiRepo(queued, { prView: [JSON.stringify({ mergeCommit: null, baseRefName: "main" })] });
  const second = loadHooks(queued);
  await bashThrough(second.handlers, second.engine, "gh pr merge 53", bashOutcome("merged", { pr: { number: 53, action: "merged" } }));
  await runTimers(queued);
  assert.deepEqual(gitCalls(queued), [], "no merge commit: nothing to resolve");
});

test("C2 ci-watch: a directory that is no repository starts nothing", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { toplevel: null });
  const { handlers, engine } = loadHooks(host);
  await bashThrough(handlers, engine, "git push", bashOutcome("pushed", { push: { branch: "feat/x" } }));
  await runTimers(host);
  assert.deepEqual(gitCalls(host), [`git -C ${CWD} rev-parse --show-toplevel`], "asked once, then stopped");
  assert.equal(host.state.size, 0);
  assert.equal(host.timers.length, 0);
});

// ---------------------------------------------------------------------------
// C3: the adaptive poll, the band row and the toast. The fake clock never
// moves with the schedule: the watch counts the delays it asked for.
// ---------------------------------------------------------------------------

/** One run as `gh run list --json` prints it. */
function ghRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { databaseId: 101, status: "completed", conclusion: "success", headBranch: "feat/x", headSha: CI_SHA, workflowName: "CI", url: "https://github.com/a/b/actions/runs/101", createdAt: "2026-09-25T10:00:30Z", updatedAt: "2026-09-25T10:25:30Z", ...overrides };
}
const RUNNING = ghRun({ status: "in_progress", conclusion: "" });
const PASSED = ghRun();
const FAILED_RUN = ghRun({ conclusion: "failure" });

const PUSH_OUTCOME = (): Record<string, unknown> => bashOutcome("pushed", { push: { branch: "feat/x" } });

function ghPolls(host: FakeHost): string[] {
  return host.processCalls.filter((call) => call.startsWith("gh run list") && !call.includes("--workflow"));
}

/** The lookups of how long a workflow usually takes. */
function ghLookups(host: FakeHost): string[] {
  return host.processCalls.filter((call) => call.startsWith("gh run list") && call.includes("--workflow"));
}

/** `count` successful runs of `minutes` each, as `gh run list --json createdAt,updatedAt` prints them. */
function ghHistory(count: number, minutes: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ createdAt: `2026-09-2${i}T10:00:00Z`, updatedAt: `2026-09-2${i}T${String(10 + Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z` }));
}

/** Runs the oldest timer alone, as the engine would when its delay is up. */
async function runNextTimer(host: FakeHost): Promise<void> {
  const fn = host.timers.shift();
  assert.ok(fn, "a timer was due");
  await fn();
}

async function pushAndWatch(host: FakeHost, options: { command?: string; outcome?: Record<string, unknown> } = {}): Promise<{ handlers: Map<string, Hook>; engine: unknown }> {
  const loaded = loadHooks(host);
  await bashThrough(loaded.handlers, loaded.engine, options.command ?? "git push -u origin feat/x", options.outcome ?? PUSH_OUTCOME());
  return loaded;
}

test("C3 ci-watch: polls gh run list for the pushed branch on a slowing schedule, confirms, and says so once the run is done", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING], [RUNNING], [PASSED], [PASSED]] });
  await pushAndWatch(host);
  await runTimers(host);

  assert.equal(ghPolls(host).length, 4);
  assert.equal(ghPolls(host)[0], "gh run list --branch feat/x --limit 30 --json databaseId,status,conclusion,headBranch,headSha,workflowName,url,createdAt,updatedAt");
  const pollIndexes = host.processCalls.flatMap((call, index) => (call.startsWith("gh run list") ? [index] : []));
  assert.ok(pollIndexes.every((index) => host.processInits[index]?.cwd === CWD), "gh runs in the repository");
  // The start, then 10 s, 15 s, the confirming 10 s, and the row's keep time.
  assert.deepEqual(host.timerDelays, [200, 10_000, 15_000, 10_000, 120_000]);
  assert.deepEqual(host.toasts, [`CI feat/x (0123456) · passed in 25 min · https://github.com/a/b/actions/runs/101`]);
});

test("C3 ci-watch: a failed run is told with its workflows", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING], [PASSED, ghRun({ databaseId: 102, workflowName: "Deploy", conclusion: "failure" })]] });
  await pushAndWatch(host);
  await runTimers(host);
  assert.deepEqual(host.toasts, [`CI feat/x (0123456) · failed "Deploy" after 25 min · https://github.com/a/b/actions/runs/101`]);
});

test("C3 ci-watch: the band shows the watch while it runs and after it ends, then drops it", async () => {
  const host = makeFakeHost();
  const docs = ghRun({ databaseId: 102, workflowName: "Docs" });
  seedCiRepo(host, { polls: [[RUNNING, docs], [PASSED, docs], [PASSED, docs], [PASSED, docs]] });
  const { handlers, engine } = await pushAndWatch(host);
  await runNextTimer(host); // the start, and the first poll with it
  assert.deepEqual(bandLines(await renderBand(handlers, engine, 200)), ["CI feat/x (0123456) · \"CI\" running for 0 s · 1 of 2 done"]);
  await runNextTimer(host); // 10 s: every run finished, once
  await runNextTimer(host); // the confirming poll, inside the settle window
  await runNextTimer(host); // and the one that agrees: done
  assert.deepEqual(bandLines(await renderBand(handlers, engine, 200)), ["CI feat/x (0123456) · passed in 25 min"]);
  host.clockOffsetMs += 3 * 60_000;
  await runNextTimer(host); // the row's keep time is up
  assert.equal(await renderBand(handlers, engine, 200), ENGINE_DRAWING, "nothing left to draw: the engine's own band");
});

test("C3 ci-watch: one watch per repository and sha - a second push of the same commit extends the first", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING], [PASSED]] });
  const { handlers, engine } = await pushAndWatch(host);
  await bashThrough(handlers, engine, "git push origin feat/x", PUSH_OUTCOME());
  assert.equal(host.timers.length, 2, "each push arms its own start");
  await runNextTimer(host);
  await runNextTimer(host); // the second start finds the sha already watched and goes away
  assert.equal(ghPolls(host).length, 1, "one poll chain");
  await runTimers(host);
  assert.equal(host.toasts.length, 1, "told once");
});

test("C3 ci-watch: a merge is watched on the branch it landed on, by its merge commit", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { prView: [JSON.stringify({ mergeCommit: { oid: CI_MERGE_SHA }, baseRefName: "main" })], polls: [[ghRun({ headSha: CI_MERGE_SHA, headBranch: "main" })]] });
  const { handlers, engine } = loadHooks(host);
  await bashThrough(handlers, engine, "gh pr merge 53 --squash", bashOutcome("merged", { pr: { number: 53, action: "merged" } }));
  await runTimers(host);
  assert.match(ghPolls(host)[0] ?? "", /^gh run list --branch main /);
  assert.deepEqual(host.toasts, [`CI main (fedcba9) · passed in 25 min · https://github.com/a/b/actions/runs/101`]);
});

test("C3 ci-watch fails open: gh missing, not signed in, no run, or a run that never ends all end the watch without a word", async () => {
  const scenarios: { name: string; polls: (Record<string, unknown>[] | "fail" | "missing")[]; expectPolls: number }[] = [
    { name: "gh cannot start", polls: ["missing"], expectPolls: 1 },
    { name: "gh fails three times in a row", polls: ["fail"], expectPolls: 3 },
    { name: "no run appears for the sha", polls: [[ghRun({ headSha: CI_MERGE_SHA })]], expectPolls: 8 },
    { name: "a run never ends (the usual-time lookup shares the 45-call ceiling)", polls: [[RUNNING]], expectPolls: 44 },
  ];
  for (const { name, polls, expectPolls } of scenarios) {
    const host = makeFakeHost();
    seedCiRepo(host, { polls });
    const { handlers, engine } = await pushAndWatch(host);
    await runTimers(host);
    assert.equal(ghPolls(host).length, expectPolls, name);
    assert.ok(ghPolls(host).length + ghLookups(host).length <= 45, `${name}: at most 45 gh run list calls`);
    assert.deepEqual(host.toasts, [], name);
    assert.equal(await renderBand(handlers, engine, 200), ENGINE_DRAWING, `${name}: no row left`);
    assert.equal(host.timers.length, 0, name);
  }
});

test("C3 ci-watch: switched off while it runs, the next poll ends it - no gh call, no row, no toast", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING]] });
  const { handlers, engine } = await pushAndWatch(host);
  await runNextTimer(host);
  assert.equal(ghPolls(host).length, 1);
  setModules(host, { "ci-watch": "off" });
  await runTimers(host);
  assert.equal(ghPolls(host).length, 1, "no further gh call");
  assert.deepEqual(host.toasts, []);
  assert.equal(await renderBand(handlers, engine, 200), ENGINE_DRAWING);
});

test("C3 ci-watch band: the engine's band and a survey are left alone; the router off does not hide the watch; a subagent band stacks above it", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING]] });
  const { handlers, engine } = await pushAndWatch(host);
  await runNextTimer(host);
  const watchLine = "CI feat/x (0123456) · \"CI\" running for 0 s";
  // Not the engine's own drawing beneath (another plugin's band): passed through as it is.
  const other = { type: "Box", props: { children: [] } };
  assert.equal(await renderBand(handlers, engine, 200, { beneath: other }), other);
  // A survey holds the band.
  assert.equal(await renderBand(handlers, engine, 200, { hasSurvey: true }), ENGINE_DRAWING);
  // The router off: the watch is still drawn.
  setModules(host, { "model-router": "off" });
  assert.deepEqual(bandLines(await renderBand(handlers, engine, 200)), [watchLine]);
  // The watcher off: nothing of it.
  setModules(host, { "ci-watch": "off" });
  assert.equal(await renderBand(handlers, engine, 200), ENGINE_DRAWING);
});

test("C3 ci-watch band: a subagent's band keeps its place and the watch is drawn under it", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedCiRepo(host, { polls: [[RUNNING]] });
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnAs(handlers, engine, spawnEvent({ model: "opus" }), "agent-1", "claude-opus-5-5");
  await bashThrough(handlers, engine, "git push -u origin feat/x", PUSH_OUTCOME());
  await runNextTimer(host);
  const lines = bandLines(await renderBand(handlers, engine, 200));
  assert.equal(lines[0], "Running agents: 1");
  assert.equal(lines.at(-1), "CI feat/x (0123456) · \"CI\" running for 0 s");
  assert.equal(lines.length, 3, "heading, the agent's row, the watch");
});

test("C3 ci-watch usual time: one lookup per watch, for the workflow that runs, shown in the band and counted in ghCalls", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING], [RUNNING], [PASSED], [PASSED], [PASSED]], history: ghHistory(4, 30) });
  const { handlers, engine } = await pushAndWatch(host);
  await runNextTimer(host); // the start and the first poll
  assert.deepEqual(ghLookups(host), ["gh run list --workflow CI --status success --limit 10 --json createdAt,updatedAt"]);
  const lookupAt = host.processCalls.findIndex((call) => call.includes("--workflow"));
  assert.equal(host.processInits[lookupAt]?.cwd, CWD, "asked in the repository");
  assert.deepEqual(bandLines(await renderBand(handlers, engine, 200)), ['CI feat/x (0123456) · "CI" running for 0 s · usually takes ~30 min']);
  host.clockOffsetMs += 40 * 60_000;
  assert.deepEqual(bandLines(await renderBand(handlers, engine, 200)), ['CI feat/x (0123456) · "CI" running for 40 min · usually takes ~30 min · slower than usual']);
  await runTimers(host);
  assert.equal(ghLookups(host).length, 1, "asked once per watch");
});

test("C3 ci-watch usual time: no history, a failing gh or a gh that cannot start leaves the usual time out and the watch carries on", async () => {
  const histories: CiRepoScript["history"][] = [[], ghHistory(2, 30), "fail", "missing"];
  for (const history of histories) {
    const host = makeFakeHost();
    seedCiRepo(host, { polls: [[RUNNING], [PASSED], [PASSED], [PASSED]], history });
    const { handlers, engine } = await pushAndWatch(host);
    await runNextTimer(host);
    assert.deepEqual(bandLines(await renderBand(handlers, engine, 200)), ['CI feat/x (0123456) · "CI" running for 0 s'], JSON.stringify(history));
    await runTimers(host);
    assert.equal(host.toasts.length, 1, "the watch still ended with its toast");
    assert.equal(ghLookups(host).length, 1);
  }
});

test("C3 ci-watch usual time: nothing is asked while no run is going, and not at all with the module off", async () => {
  const quiet = makeFakeHost();
  seedCiRepo(quiet, { polls: [[PASSED]], history: ghHistory(4, 30) });
  await pushAndWatch(quiet);
  await runTimers(quiet);
  assert.equal(ghLookups(quiet).length, 0);
  const off = makeFakeHost();
  seedCiRepo(off, { polls: [[RUNNING]], history: ghHistory(4, 30) });
  setModules(off, { "ci-watch": "off" });
  await pushAndWatch(off);
  await runTimers(off);
  assert.equal(off.processCalls.filter((call) => call.startsWith("gh ")).length, 0);
});

// ---------------------------------------------------------------------------
// C4: the measure. What the agent itself spent waiting for the run - CI polls
// and sleeps of 10 s or more, in the main thread, while a watch is open - is
// what a note would have replaced. One row per watch, numbers and names only.
// ---------------------------------------------------------------------------

function ciRows(host: FakeHost): Record<string, unknown>[] {
  return (host.files.get(CI_LOG_PATH) ?? "").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A main-thread Bash call that is not a trigger, through the hook: `next` answers plain output. */
async function plainBash(handlers: Map<string, Hook>, engine: unknown, command: string, agentId?: string): Promise<void> {
  await bashThrough(handlers, engine, command, bashOutcome("output"), agentId);
}

test("C4 ci-watch shadow: counts the agent's own CI polls and long sleeps made during the watch, and writes one row when it ends; no prompt is submitted", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING], [RUNNING], [PASSED], [PASSED]] });
  const { handlers, engine } = await pushAndWatch(host);
  // Made before the watch has even found its sha: still during it.
  await plainBash(handlers, engine, "gh run list --branch feat/x");
  await runNextTimer(host);
  await plainBash(handlers, engine, "sleep 60");
  await plainBash(handlers, engine, "sleep 60 && gh run view 5 --log-failed");
  await plainBash(handlers, engine, "gh pr checks --watch");
  await plainBash(handlers, engine, "sleep 2");
  await plainBash(handlers, engine, "ls -la");
  await plainBash(handlers, engine, "sleep 90", "agent-1");
  await plainBash(handlers, engine, "gh run watch 5", "agent-1");
  host.clockOffsetMs += 187_000;
  await runTimers(host);
  // After the end: not counted.
  await plainBash(handlers, engine, "gh run view 5");

  const rows = ciRows(host);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], at: "x", account: "x" }, {
    at: "x",
    account: "x",
    project: "sandbox",
    sessionId: "session-1",
    mode: "shadow",
    trigger: "push",
    outcome: "success",
    watchedSeconds: 187,
    ghCalls: 5,
    agentPolls: 3,
    agentSleeps: 1,
    notified: true,
    injected: false,
  });
  assert.deepEqual(host.submits, [], "shadow never talks to the agent");
});

test("C4 ci-watch: the row holds no command, path, branch, sha or url", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[PASSED]] });
  const { handlers, engine } = await pushAndWatch(host);
  await plainBash(handlers, engine, "gh run view 5 --repo secret-org/private-repo");
  await runTimers(host);
  const text = host.files.get(CI_LOG_PATH) ?? "";
  assert.ok(text.length > 0, "a row was written");
  for (const needle of ["private-repo", "secret-org", "feat/x", CI_SHA, "github.com", "gh run"]) assert.ok(!text.includes(needle), needle);
});

test("C4 ci-watch: a watch that ends without a verdict still writes its row, and the person is told nothing", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[]] });
  await pushAndWatch(host);
  await runTimers(host);
  const [row] = ciRows(host);
  assert.equal(row?.outcome, "no-runs");
  assert.equal(row?.notified, false);
  assert.equal(row?.ghCalls, 8);
  assert.deepEqual(host.toasts, []);

  const missing = makeFakeHost();
  seedCiRepo(missing, { polls: ["missing"] });
  await pushAndWatch(missing);
  await runTimers(missing);
  assert.equal(ciRows(missing)[0]?.outcome, "gh-missing");
  assert.equal(ciRows(missing)[0]?.ghCalls, 0, "a gh that never started ran no process");
});

test("C4 ci-watch off: no count and no row; a watch switched off in the middle leaves none either", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING]] });
  setModules(host, { "ci-watch": "off" });
  const { handlers, engine } = loadHooks(host);
  await bashThrough(handlers, engine, "git push", PUSH_OUTCOME());
  await plainBash(handlers, engine, "gh run watch 5");
  await runTimers(host);
  assert.equal(host.files.has(CI_LOG_PATH), false);

  const middle = makeFakeHost();
  seedCiRepo(middle, { polls: [[RUNNING]] });
  await pushAndWatch(middle);
  await runNextTimer(middle);
  setModules(middle, { "ci-watch": "off" });
  await runTimers(middle);
  assert.equal(middle.files.has(CI_LOG_PATH), false);
});

// ---------------------------------------------------------------------------
// C5: Active tells the agent once, when the session is idle. The note is
// short, goes through `$.prompt.submit` as the plugin's (never as the person's
// words), and never for a subagent or a watch that ended without a verdict.
// ---------------------------------------------------------------------------

const CI_NOTE = "CI for 0123456 on feat/x: success, https://github.com/a/b/actions/runs/101";

async function startTurn(handlers: Map<string, Hook>, engine: unknown, turnId: string): Promise<void> {
  const start = handlers.get("turn.start");
  assert.ok(start, "turn.start was never registered");
  await start(engine, { text: "", turnId }, async (e: unknown) => ({ turnId: (e as { turnId: string }).turnId }));
}

test("C5 ci-watch active: once the run ends and no turn is running, exactly one note goes to the agent", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING], [PASSED], [PASSED], [PASSED]] });
  setModules(host, { "ci-watch": "active" });
  await pushAndWatch(host);
  await runTimers(host);
  assert.deepEqual(host.submits, [{ text: CI_NOTE }], "one note, the plugin's own words: no asUser");
  assert.deepEqual(host.toasts, [`CI feat/x (0123456) · passed in 25 min · https://github.com/a/b/actions/runs/101`], "the person is told as well");
  const [row] = ciRows(host);
  assert.equal(row?.mode, "active");
  assert.equal(row?.injected, true);
});

test("C5 ci-watch active: a failed run names its workflows in the note", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[RUNNING], [PASSED, ghRun({ databaseId: 102, workflowName: "Deploy", conclusion: "failure", url: "https://github.com/a/b/actions/runs/102" })]] });
  setModules(host, { "ci-watch": "active" });
  await pushAndWatch(host);
  await runTimers(host);
  assert.deepEqual(host.submits, [{ text: "CI for 0123456 on feat/x: failure (Deploy), https://github.com/a/b/actions/runs/102" }]);
});

test("C5 ci-watch active: while a turn runs the note waits for the turn to end, and goes once", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[PASSED]] });
  setModules(host, { "ci-watch": "active" });
  const { handlers, engine } = loadHooks(host);
  await startTurn(handlers, engine, "turn-1");
  await bashThrough(handlers, engine, "git push -u origin feat/x", PUSH_OUTCOME());
  await runTimers(host);
  assert.deepEqual(host.submits, [], "a turn is running: nothing is submitted over it");
  assert.equal(host.files.has(CI_LOG_PATH), false, "the row is written when the note's fate is known");

  await completeTurn(handlers, engine);
  await runTimers(host);
  assert.deepEqual(host.submits, [{ text: CI_NOTE }]);
  assert.equal(ciRows(host)[0]?.injected, true);

  await completeTurn(handlers, engine);
  await runTimers(host);
  assert.equal(host.submits.length, 1, "at most once per watch");
  assert.equal(ciRows(host).length, 1);
});

test("C5 ci-watch active: a subagent's turn ending does not release the note", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[PASSED]] });
  setModules(host, { "ci-watch": "active" });
  const { handlers, engine } = loadHooks(host);
  await startTurn(handlers, engine, "turn-1");
  await bashThrough(handlers, engine, "git push -u origin feat/x", PUSH_OUTCOME());
  await runTimers(host);
  await completeSubagent(handlers, engine, "agent-1");
  await runTimers(host);
  assert.deepEqual(host.submits, []);
});

test("C5 ci-watch: a note waiting for idle is dropped if the module is no longer Active when the turn ends", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[PASSED]] });
  setModules(host, { "ci-watch": "active" });
  const { handlers, engine } = loadHooks(host);
  await startTurn(handlers, engine, "turn-1");
  await bashThrough(handlers, engine, "git push -u origin feat/x", PUSH_OUTCOME());
  await runTimers(host);
  setModules(host, { "ci-watch": "shadow" });
  await completeTurn(handlers, engine);
  await runTimers(host);
  assert.deepEqual(host.submits, []);
  assert.equal(ciRows(host)[0]?.injected, false);
  assert.equal(ciRows(host)[0]?.mode, "shadow");

  const off = makeFakeHost();
  seedCiRepo(off, { polls: [[PASSED]] });
  setModules(off, { "ci-watch": "active" });
  const second = loadHooks(off);
  await startTurn(second.handlers, second.engine, "turn-1");
  await bashThrough(second.handlers, second.engine, "git push -u origin feat/x", PUSH_OUTCOME());
  await runTimers(off);
  setModules(off, { "ci-watch": "off" });
  await completeTurn(second.handlers, second.engine);
  await runTimers(off);
  assert.deepEqual(off.submits, []);
});

test("C5 ci-watch active: a watch that ends without a verdict sends nothing", async () => {
  const host = makeFakeHost();
  seedCiRepo(host, { polls: [[]] });
  setModules(host, { "ci-watch": "active" });
  await pushAndWatch(host);
  await runTimers(host);
  assert.deepEqual(host.submits, []);
  assert.equal(ciRows(host)[0]?.injected, false);
});

test("C5 ci-watch: the note costs no Jev call and is not a person turn", async () => {
  const host = makeFakeHost();
  seedProjectSkill(host, "graft-helper", "Look up code with graft", "Use graft to read the code.");
  seedSamplingConfig(host, { enabled: true, sampleRate: 1, dailyPromptCap: 1000 });
  const { handlers, engine } = loadHooks(host);
  // The control: a person's prompt does ask Jev in this setup.
  await submitPrompt(handlers, engine, "fix the parser please");
  assert.ok(host.fetchCalls.length > 0, "the control prompt reached Jev");
  host.fetchCalls.length = 0;
  const submit = handlers.get("prompt.submit");
  assert.ok(submit);
  const note = { text: CI_NOTE, wait: false, origin: { kind: "plugin", name: "orca-jev-mod-skills" } };
  const passed = await submit(engine, note, promptSubmitNext);
  assert.equal(host.fetchCalls.length, 0, "no Jev call for the note");
  assert.equal(passed, note, "the event goes on as it came");
  // A text that only looks like the note, from a person, is still a prompt like any other.
  host.fetchCalls.length = 0;
  await submitPrompt(handlers, engine, CI_NOTE);
  assert.ok(host.fetchCalls.length > 0, "only the plugin's own note is skipped");
});

test("C5 ci-watch with K0b: the note is not a scored prompt, so it writes no typing row", async () => {
  const host = makeFakeHost();
  const { handlers, engine } = loadHooks(host);
  await submitFrom(handlers, engine, CI_NOTE, "plugin");
  assert.equal(host.files.has(TYPING_PATH), false, "no typing row for the plugin's own note");
  // The control: another plugin prompt is scored and writes its row.
  await submitFrom(handlers, engine, "run the release checks", "plugin");
  assert.deepEqual(typingRows(host).map((row) => row.kind), ["injected"]);
});

test("C3 ci-watch: a reload forgets the watches - a row left in state by the old load is cleared at session.start", async () => {
  const host = makeFakeHost();
  host.state.set("ciWatches", { rows: [{ id: "old", sha7: "abcdef0", branch: "main", status: "watching", startedAtMs: Date.parse("2026-09-25T10:00:00Z"), done: 0, total: 1, failed: [], running: ["CI"], typicalWorkflow: null, typicalSeconds: null, durationMs: null, finishedAtMs: null }] });
  const { handlers, engine } = loadHooks(host);
  assert.equal(bandLines(await renderBand(handlers, engine, 200)).length, 1, "before: the old row would be drawn");
  await startSession(handlers, engine);
  assert.equal(await renderBand(handlers, engine, 200), ENGINE_DRAWING);
  assert.deepEqual(host.state.get("ciWatches"), { rows: [] });
});

// ---------------------------------------------------------------------------
// Memory in Shadow (odd/tasks/memory-shadow.md, M8): session.start detects the
// backend (the tool list and one read-only mem_current_project); after a main
// turn that ended with an answer, a timer runs the free checks, asks Haiku
// SKIP or UPDATE, drafts on a sampled UPDATE with a fork, builds the judge dry
// and logs one row. tool.call only observes the main thread's own saves.
// Nothing is ever written: no mem_save, no mem_judge, no memory file.
// ---------------------------------------------------------------------------

const MEMORY_ROWS_PATH = `${CACHE_DIR}/memory-decisions-2026-09-25T10.jsonl`;
const MEMORY_ACCOUNT_DIR = "/orca/claude-accounts/acct-1/auth";
const MEMORY_DIR = `${MEMORY_ACCOUNT_DIR}/projects/-home-dev-Projects-sandbox/memory`;
const ENGRAM_TOOLS = [
  { name: "mcp__engram__mem_save", description: "", mcp: true },
  { name: "mcp__engram__mem_current_project", description: "", mcp: true },
];
const MEMORY_TURN: Row[] = [
  { role: "user", text: "De ahora en adelante respóndeme en español con tú, nunca voseo.", toolUses: [] },
  { role: "assistant", text: "Entendido, te hablo con tú.", toolUses: [] },
];
const USAGE = (input: number, output: number, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 });
const GATE_UPDATE = { isAnswered: true, text: "UPDATE: the person wants Spanish with tú", usage: USAGE(900, 9) };
const GATE_SKIP = { isAnswered: true, text: "SKIP", usage: USAGE(900, 1) };
const DRAFT_REPLY = {
  isAnswered: true,
  text: JSON.stringify({ saves: [{ type: "feedback", title: "Spanish with tú", content: "Reply in Spanish with tú, never voseo.", topic_key: "spanish-tu" }], updates: [], deletes: [] }),
  usage: USAGE(12, 140, 180_000),
};
const HEALTHY = (_server: string, tool: string): unknown => {
  if (tool === "mem_current_project") return { content: [{ type: "text", text: JSON.stringify({ project: "sandbox" }) }], isError: false };
  throw new Error(`fake host: unexpected Engram tool ${tool}`);
};

function turnIdWhere(sampled: boolean): string {
  for (let i = 0; i < 1000; i += 1) if (isForkSampled("session-1", `turn-${i}`) === sampled) return `turn-${i}`;
  throw new Error("no turn id found");
}

function memoryHost(options: { engram?: boolean } = {}): FakeHost {
  const host = makeFakeHost();
  host.env.set("CLAUDE_CONFIG_DIR", MEMORY_ACCOUNT_DIR);
  host.repo = { root: CWD };
  host.messages = MEMORY_TURN;
  host.files.set(`${MEMORY_DIR}/MEMORY.md`, "- [Merge email](merge-email.md) — use the noreply address\n");
  host.files.set(`${MEMORY_DIR}/merge-email.md`, "---\nname: merge-email\nmetadata:\n  type: feedback\n  topic_key: merge-email\n---\n\nUse the noreply address.\n");
  if (options.engram !== false) {
    host.toolList = [...ENGRAM_TOOLS];
    host.mcpAnswer = HEALTHY;
  }
  return host;
}

async function startSessionWith(handlers: Map<string, Hook>, engine: unknown): Promise<unknown> {
  const hook = handlers.get("session.start");
  assert.ok(hook, "session.start was never registered");
  return hook(engine, { source: "startup" }, async (e: unknown) => e);
}

/** Fires tool.call on the main thread; `next` answers `answer` and is counted. */
async function mainToolCall(handlers: Map<string, Hook>, engine: unknown, tool: string, args: Record<string, unknown>, answer: unknown): Promise<{ result: unknown; nexts: number }> {
  const hook = handlers.get("tool.call");
  assert.ok(hook, "tool.call was never registered");
  let nexts = 0;
  const result = await hook(engine, { tool, tool_use_id: `toolu_${tool}`, ...args }, async () => {
    nexts += 1;
    return answer;
  });
  return { result, nexts };
}

function memoryRows(host: FakeHost): Record<string, unknown>[] {
  return (host.files.get(MEMORY_ROWS_PATH) ?? "").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Shadow writes nothing: no Engram write call, nothing under the account's memory or spool folders. */
function assertNothingWritten(host: FakeHost, seeded: ReadonlySet<string>): void {
  assert.deepEqual(host.mcpCalls.filter((call) => call.tool !== "mem_current_project"), [], "the only Engram call is the read-only health check");
  const written = [...host.files.keys()].filter((path) => !seeded.has(path));
  assert.deepEqual(written.filter((path) => path.startsWith(MEMORY_ACCOUNT_DIR) || path.includes("spool")), [], "no memory file, no spool");
}

test("M8 memory shadow (the default): a sampled UPDATE turn asks Haiku once, forks once, builds the judge dry and logs one row; nothing is written", async () => {
  const host = memoryHost();
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const seeded = new Set(host.files.keys());
  const seededMemory = new Map([...host.files].filter(([path]) => path.startsWith(MEMORY_DIR)));
  const { handlers, engine } = loadHooks(host);

  await startSessionWith(handlers, engine);
  await runTimers(host);
  assert.deepEqual(host.mcpCalls, [{ server: "engram", tool: "mem_current_project", args: {} }], "one health call at start");

  // The main thread saves on its own; the hook only watches, after next.
  const saveAnswer = { result: { content: [{ type: "text", text: JSON.stringify({ id: 5, judgment_required: true, candidates: [{ id: 3, title: "Spanish with vos", type: "policy", judgment_id: "rel-1" }] }) }], isError: false } };
  const saved = await mainToolCall(handlers, engine, "mcp__engram__mem_save", { title: "Spanish with tú", type: "policy", content: "x" }, saveAnswer);
  assert.equal(saved.result, saveAnswer, "next(e)'s result comes back as it was");
  assert.equal(saved.nexts, 1);
  const judged = await mainToolCall(handlers, engine, "mcp__engram__mem_judge", { judgment_id: "rel-1", relation: "supersedes" }, { result: "ok" });
  assert.equal(judged.nexts, 1);

  const result = await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  assert.equal(result, TURN_RESULT, "next(e)'s result is handed back as it was");
  await runTimers(host);

  assert.equal(host.modelCalls.length, 1, "one Haiku gate");
  assert.equal(host.modelCalls[0]?.model, "haiku");
  assert.equal(host.forkCalls.length, 1, "one fork on a sampled UPDATE");
  assert.match(host.forkCalls[0] ?? "", /^\[orca-memory\]/, "the fork's prompt carries the module's own marker");
  assert.match(host.forkCalls[0] ?? "", /merge-email/, "Engram live: the fork reuses the auto-memory topic keys");
  const rows = memoryRows(host);
  assert.equal(rows.length, 1);
  const row = rows[0] ?? {};
  assert.deepEqual({ ...row, at: "x", account: "x", gateMs: "x", forkMs: "x" }, {
    at: "x",
    account: "x",
    project: "sandbox",
    mode: "shadow",
    effective: "shadow",
    sessionId: "session-1",
    backend: "live",
    decidedBy: "tools+health",
    permission: "ok",
    detectedAt: "start",
    gate: "update",
    gateMs: "x",
    gateTokens: { input: 900, output: 9, cacheRead: 0, cacheWrite: 0 },
    forkSampled: true,
    fork: "drafted",
    forkMs: "x",
    forkTokens: { input: 12, output: 140, cacheRead: 180_000, cacheWrite: 0 },
    wouldSave: { user: 0, feedback: 1, project: 0, reference: 0 },
    wouldUpdate: 0,
    wouldDelete: 0,
    toEngram: 1,
    toAutoMemory: 1,
    judgeBuilds: 1,
    mainEngramSaves: 1,
    mainEngramSaveTypes: { policy: 1 },
    mainJudges: 1,
    mainCandidates: 1,
    mainAutoMemoryWrites: 0,
    agreement: "both",
    spooled: 0,
    written: 0,
    updated: 0,
    backups: 0,
    dropped: 0,
    writeFailures: 0,
    lockHeld: false,
    engramSaved: 0,
    engramFailed: 0,
    mirrored: 0,
    judged: 0,
    judgePending: 0,
    judgeUnavailable: 0,
    judgeFailed: 0,
    droppedMainSaved: 0,
    judgeTokens: { input: 0, output: 0 },
  });
  assert.doesNotMatch(JSON.stringify(row), /Spanish|vos|tú/, "no memory text or title in the row");
  assertNothingWritten(host, seeded);
  for (const [path, content] of seededMemory) assert.equal(host.files.get(path), content, `${path} byte for byte`);
  assert.deepEqual([...host.state.keys()].filter((key) => key.startsWith("memory")), ["memory"], "one state key");
});

test("M8 memory shadow: an UPDATE outside the sample makes no fork; a SKIP neither; both log a row", async () => {
  const cases: { gate: unknown; turnId: string; fork: string | null; agreement: string }[] = [
    { gate: GATE_UPDATE, turnId: turnIdWhere(false), fork: "not-sampled", agreement: "module-only" },
    { gate: GATE_SKIP, turnId: turnIdWhere(true), fork: null, agreement: "neither" },
  ];
  for (const { gate, turnId, fork, agreement } of cases) {
    const host = memoryHost();
    host.modelQueue.push(gate);
    host.forkQueue.push(DRAFT_REPLY);
    const seeded = new Set(host.files.keys());
    const { handlers, engine } = loadHooks(host);
    await startSessionWith(handlers, engine);
    await completeTurn(handlers, engine, { turnId });
    await runTimers(host);
    assert.equal(host.modelCalls.length, 1, String(fork));
    assert.equal(host.forkCalls.length, 0, String(fork));
    const row = memoryRows(host)[0];
    assert.equal(row?.fork, fork);
    assert.equal(row?.forkSampled, false);
    assert.deepEqual(row?.wouldSave, { user: 0, feedback: 0, project: 0, reference: 0 });
    assert.equal(row?.agreement, agreement);
    assertNothingWritten(host, seeded);
  }
});

test("memory detection: an Engram without mem_current_project (1.12.0) gets no health call and reads live by its tools", async () => {
  const host = memoryHost({ engram: false });
  host.toolList = ["mem_save", "mem_search", "mem_context", "mem_update"].map((tool) => ({ name: `mcp__plugin_engram_engram__${tool}`, description: "", mcp: true }));
  host.modelQueue.push(GATE_SKIP);
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  await runTimers(host);
  assert.deepEqual(host.mcpCalls, [], "no call to a tool the server does not list");
  const row = memoryRows(host)[0];
  assert.equal(row?.backend, "live");
  assert.equal(row?.decidedBy, "tools");
});

test("M8 memory off: no detection, no Haiku call, no fork, no row; nothing scheduled", async () => {
  const host = memoryHost();
  setModules(host, { memory: "off", "verify-done": "off", steward: "off" });
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  const answer = { result: "saved" };
  const observed = await mainToolCall(handlers, engine, "mcp__engram__mem_save", { type: "policy" }, answer);
  assert.equal(observed.result, answer);
  assert.equal(observed.nexts, 1);
  const result = await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  assert.equal(result, TURN_RESULT);
  assert.equal(host.timers.length, 0, "nothing scheduled");
  await runTimers(host);
  assert.equal(host.modelCalls.length, 0);
  assert.equal(host.forkCalls.length, 0);
  assert.equal(host.mcpCalls.length, 0);
  assert.equal(host.files.has(MEMORY_ROWS_PATH), false);
  assert.equal(host.state.has("memory"), false);
  assertNothingWritten(host, seeded);
});

test("M8 memory: a timer already scheduled does nothing once the module went off", async () => {
  const host = memoryHost();
  host.modelQueue.push(GATE_UPDATE);
  const { handlers, engine } = loadHooks(host);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  setModules(host, { memory: "off" });
  await runTimers(host);
  assert.equal(host.modelCalls.length, 0);
  assert.equal(host.files.has(MEMORY_ROWS_PATH), false);
});

test("M8 memory: a subagent's turn, a turn that did not end with an answer, a slash command and the module's own marker do nothing", async () => {
  const cases: { extra: Record<string, unknown>; messages: Row[] }[] = [
    { extra: { agentId: "a-1" }, messages: MEMORY_TURN },
    { extra: { reason: "aborted", isAborted: true }, messages: MEMORY_TURN },
    { extra: { reason: "error" }, messages: MEMORY_TURN },
    { extra: {}, messages: [{ role: "user", text: "/compact", toolUses: [] }, { role: "assistant", text: "ok", toolUses: [] }] },
    { extra: {}, messages: [{ role: "user", text: "[orca-memory] This message is from the memory module", toolUses: [] }, { role: "assistant", text: "{}", toolUses: [] }] },
  ];
  for (const { extra, messages } of cases) {
    const host = memoryHost();
    host.messages = messages;
    host.modelQueue.push(GATE_UPDATE);
    const { handlers, engine } = loadHooks(host);
    const result = await completeTurn(handlers, engine, { turnId: turnIdWhere(true), ...extra });
    await runTimers(host);
    const label = JSON.stringify({ extra, prompt: messages[0]?.text });
    assert.equal(result, TURN_RESULT, label);
    assert.equal(host.modelCalls.length, 0, label);
    assert.equal(host.files.has(MEMORY_ROWS_PATH), false, label);
  }
});

test("M8 memory: no Engram anywhere is auto-memory alone; no MCP call; the fork reads the memory files", async () => {
  const host = memoryHost({ engram: false });
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  await runTimers(host);
  assert.equal(host.mcpCalls.length, 0);
  assert.match(host.forkCalls[0] ?? "", /<file name="merge-email.md">/);
  assert.doesNotMatch(host.forkCalls[0] ?? "", /<file name="MEMORY.md">/, "the index is not a memory");
  const row = memoryRows(host)[0];
  assert.equal(row?.backend, "absent");
  assert.equal(row?.decidedBy, "none");
  assert.equal(row?.detectedAt, "turn", "start saw no Engram, so the turn checked again");
  assert.equal(row?.toEngram, 0);
  assert.equal(row?.toAutoMemory, 1);
  assert.equal(row?.judgeBuilds, 0, "no Engram, no judge");
  assertNothingWritten(host, seeded);
});

test("M8 memory: Engram configured but not connected is configured-down, decided by the user-scope config", async () => {
  const host = memoryHost({ engram: false });
  host.files.set(`${MEMORY_ACCOUNT_DIR}/.claude.json`, JSON.stringify({ mcpServers: { engram: { command: "/opt/homebrew/bin/engram", args: ["mcp"] } } }));
  host.modelQueue.push(GATE_SKIP);
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  await runTimers(host);
  const row = memoryRows(host)[0];
  assert.equal(row?.backend, "configured-down");
  assert.equal(row?.decidedBy, "user-config");
});

test("M8 memory: Engram tools that connect after the start are found at the first turn, with one health call a session", async () => {
  const host = memoryHost({ engram: false });
  host.modelQueue.push(GATE_SKIP, GATE_SKIP);
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  host.toolList = [...ENGRAM_TOOLS];
  host.mcpAnswer = HEALTHY;
  await completeTurn(handlers, engine, { turnId: "turn-a" });
  await runTimers(host);
  await completeTurn(handlers, engine, { turnId: "turn-b" });
  await runTimers(host);
  assert.equal(host.mcpCalls.length, 1, "the health call is made once a session");
  assert.deepEqual(memoryRows(host).map((row) => [row.backend, row.detectedAt]), [["live", "turn"], ["live", "turn"]]);
});

test("M8 memory: a refused health call is live with permission refused, never down; a failing one is configured-down", async () => {
  const cases = [
    { error: "$.mcp.call(engram, mem_current_project) refused: Claude requested permissions to use mcp__engram__mem_current_project, but you haven't granted it yet.", backend: "live", permission: "refused" },
    { error: "connection closed", backend: "configured-down", permission: "unknown" },
  ];
  for (const { error, backend, permission } of cases) {
    const host = memoryHost();
    host.mcpAnswer = () => {
      throw new Error(error);
    };
    host.modelQueue.push(GATE_SKIP);
    const { handlers, engine } = loadHooks(host);
    await startSessionWith(handlers, engine);
    await runTimers(host);
    await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
    await runTimers(host);
    const row = memoryRows(host)[0];
    assert.equal(row?.backend, backend, error);
    assert.equal(row?.permission, permission, error);
  }
});

test("M8 memory: a health check that failed at the start (a cold dial) is asked once more at the first turn, and no more", async () => {
  const host = memoryHost();
  host.mcpAnswer = () => {
    throw new Error("timed out");
  };
  host.modelQueue.push(GATE_SKIP, GATE_SKIP);
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  host.mcpAnswer = HEALTHY;
  await completeTurn(handlers, engine, { turnId: "turn-a" });
  await runTimers(host);
  await completeTurn(handlers, engine, { turnId: "turn-b" });
  await runTimers(host);
  assert.equal(host.mcpCalls.length, 2, "the start's, and one at the first turn");
  assert.deepEqual(memoryRows(host).map((row) => [row.backend, row.detectedAt]), [["live", "turn"], ["live", "turn"]]);
});

test("M8 memory: what Haiku reads is the index and the redacted last exchange; a malformed answer is no verdict and no fork", async () => {
  const host = memoryHost();
  const secret = "sk-ant-api03-" + "c".repeat(40);
  host.messages = [
    { role: "user", text: `Guarda que la clave del staging es ${secret}`, toolUses: [] },
    { role: "assistant", text: "No guardo secretos.", toolUses: [{ tool_use_id: "r1", tool: "Read", input: { file_path: "/secret/path.ts" }, text: "SECRET_FILE_CONTENTS" }] },
  ];
  host.modelQueue.push({ isAnswered: true, text: "I think UPDATE because it matters", usage: USAGE(800, 12) });
  host.forkQueue.push(DRAFT_REPLY);
  const { handlers, engine } = loadHooks(host);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  await runTimers(host);
  const sent = JSON.stringify(host.modelCalls[0] ?? {});
  assert.match(sent, /Merge email/, "the MEMORY.md index");
  assert.match(sent, /la clave del staging/, "the exchange");
  assert.ok(!sent.includes(secret), "the secret is redacted");
  assert.ok(!sent.includes("SECRET_FILE_CONTENTS"), "no tool output");
  assert.ok(!sent.includes("/secret/path.ts"), "no tool input");
  assert.equal(host.forkCalls.length, 0);
  const row = memoryRows(host)[0];
  assert.equal(row?.gate, "malformed");
  assert.equal(row?.fork, null);
  assert.equal(row?.agreement, "unknown");
});

test("M8 memory: a gate with no answer logs no-answer; a model call that rejects logs nothing and the turn is untouched", async () => {
  const host = memoryHost();
  host.modelQueue.push({ isAnswered: false, reason: "api-error", status: 529, error: "overloaded", usage: USAGE(0, 0) });
  const { handlers, engine } = loadHooks(host);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  await runTimers(host);
  assert.equal(memoryRows(host)[0]?.gate, "no-answer");

  const rejecting = memoryHost();
  const loaded = loadHooks(rejecting);
  const result = await completeTurn(loaded.handlers, loaded.engine, { turnId: turnIdWhere(true) });
  await runTimers(rejecting);
  assert.equal(result, TURN_RESULT);
  assert.equal(rejecting.files.has(MEMORY_ROWS_PATH), false);
});

test("M8 memory: a sampled fork is skipped when the next turn already started", async () => {
  const host = memoryHost();
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const { handlers, engine } = loadHooks(host);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  const start = handlers.get("turn.start");
  assert.ok(start);
  await start(engine, { turnId: "turn-next" }, async (e: unknown) => e);
  await runTimers(host);
  assert.equal(host.forkCalls.length, 0);
  assert.equal(memoryRows(host)[0]?.fork, "turn-moved-on");
});

test("M8 memory: a main-thread Write into the memory folder is seen; one elsewhere, or a subagent's, is not", async () => {
  const host = memoryHost();
  host.modelQueue.push(GATE_SKIP);
  const { handlers, engine } = loadHooks(host);
  const answer = { result: "written" };
  const inMemory = await mainToolCall(handlers, engine, "Write", { file_path: `${MEMORY_DIR}/feedback_tu.md`, content: "x" }, answer);
  assert.equal(inMemory.result, answer);
  await mainToolCall(handlers, engine, "Write", { file_path: `${CWD}/notes.md`, content: "x" }, answer);
  const hook = handlers.get("tool.call");
  assert.ok(hook);
  await hook(engine, { tool: "Write", tool_use_id: "s1", agentId: "a-1", file_path: `${MEMORY_DIR}/sub.md`, content: "x" }, async () => answer);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  await runTimers(host);
  const row = memoryRows(host)[0];
  assert.equal(row?.mainAutoMemoryWrites, 1);
  assert.equal(row?.agreement, "main-only");
});

test("M8 memory: what was seen belongs to its own turn; the next turn starts from zero", async () => {
  const host = memoryHost();
  host.modelQueue.push(GATE_SKIP, GATE_SKIP);
  const { handlers, engine } = loadHooks(host);
  await mainToolCall(handlers, engine, "mcp__engram__mem_save", { type: "discovery" }, { result: "{}" });
  await completeTurn(handlers, engine, { turnId: "turn-a" });
  await completeTurn(handlers, engine, { turnId: "turn-b" });
  await runTimers(host);
  assert.deepEqual(memoryRows(host).map((row) => row.mainEngramSaves), [1, 0]);
});

// ---------------------------------------------------------------------------
// Memory in Active, files store (odd/tasks/memory-active-files.md, A4): with
// no Engram, or Engram configured but down, every UPDATE is drafted; each
// save is spooled before any memory file is touched, then written with its
// MEMORY.md line, and the item moves to done/. An existing file is copied
// byte for byte to .memory-backup before it is rewritten. With Engram live,
// Active keeps measuring and writes nothing. `$.process.run` acts on the
// fake files as the shell would (mkdir, mv, cp, rm, kill -0).
// ---------------------------------------------------------------------------

const MEMORY_SPOOL_ROOT = memorySpoolRoot(CACHE_DIR, MEMORY_DIR);
const MERGE_EMAIL_PATH = `${MEMORY_DIR}/merge-email.md`;
const DRAFT_UPDATE_TEXT = "---\nname: merge-email\ndescription: \"use the noreply address\"\nmetadata:\n  type: feedback\n---\n\nUse merge-bot@example.com.\n";

function draftReply(draft: { saves?: unknown[]; updates?: unknown[]; deletes?: unknown[] }): unknown {
  return { isAnswered: true, text: JSON.stringify({ saves: draft.saves ?? [], updates: draft.updates ?? [], deletes: draft.deletes ?? [] }), usage: USAGE(12, 140, 180_000) };
}

/** `$.process.run` for the memory write path: the shell's mkdir, mv, cp and rm on the fake files, and kill -0 answering `alive`. */
function memoryShell(host: FakeHost, options: { alive?: boolean; failCopy?: boolean } = {}): void {
  const done = { exitCode: 0, stdout: "", stderr: "" };
  const failed = { exitCode: 1, stdout: "", stderr: "no such file" };
  host.processHandler = (argv) => {
    const [command, ...rest] = argv;
    const paths = rest.filter((arg) => !arg.startsWith("-"));
    const from = paths[0] ?? "";
    const to = paths[1] ?? "";
    if (command === "mkdir") return done;
    if (command === "kill") return options.alive === true ? done : failed;
    if (command === "rm") {
      host.files.delete(from);
      return done;
    }
    const text = host.files.get(from);
    if (command === "mv") {
      if (text === undefined) return failed;
      host.files.delete(from);
      host.files.set(to, text);
      return done;
    }
    if (command === "cp") {
      if (text === undefined || options.failCopy === true) return failed;
      host.files.set(to, text);
      return done;
    }
    return undefined;
  };
}

/** The order files were written in, by path (every `$.fs.write`, and every copy or move the fake shell makes). */
function recordWrites(host: FakeHost): string[] {
  const order: string[] = [];
  const set = host.files.set.bind(host.files);
  host.files.set = (path: string, text: string) => {
    order.push(path);
    return set(path, text);
  };
  return order;
}

function activeHost(options: { engram?: boolean; down?: boolean } = {}): FakeHost {
  const host = memoryHost({ engram: options.engram ?? false });
  if (options.down === true) host.files.set(`${MEMORY_ACCOUNT_DIR}/.claude.json`, JSON.stringify({ mcpServers: { engram: { command: "/opt/homebrew/bin/engram", args: ["mcp"] } } }));
  setModules(host, { memory: "active" });
  memoryShell(host);
  return host;
}

function spoolFiles(host: FakeHost): string[] {
  return [...host.files.keys()].filter((path) => path.startsWith(`${CACHE_DIR}/memory-spool/`)).sort();
}

function writesOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return { spooled: row?.spooled, written: row?.written, updated: row?.updated, backups: row?.backups, dropped: row?.dropped, writeFailures: row?.writeFailures, lockHeld: row?.lockHeld };
}

async function activeTurn(host: FakeHost, turnId = turnIdWhere(false)): Promise<{ handlers: Map<string, Hook>; engine: unknown; result: unknown }> {
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  const result = await completeTurn(handlers, engine, { turnId });
  await runTimers(host);
  return { handlers, engine, result };
}

test("A4 memory active, no Engram: an UPDATE outside Shadow's sample is drafted; the save is spooled, then written with its MEMORY.md line, then moved to done", async () => {
  const host = activeHost();
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const order = recordWrites(host);
  const { result } = await activeTurn(host);

  assert.equal(result, TURN_RESULT, "next(e)'s result is handed back as it was");
  assert.equal(host.modelCalls.length, 1, "one Haiku gate");
  assert.equal(host.forkCalls.length, 1, "Active drafts every UPDATE, sampled or not");
  assert.match(host.forkCalls[0] ?? "", /<file name="merge-email.md">/, "the fork reads the current files, so it can update instead of duplicating");
  assert.equal(host.mcpCalls.length, 0, "no Engram, no MCP call");

  const file = host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "";
  assert.match(file, /^---\nname: spanish-tu\ndescription: "Spanish with tú"\nmetadata:\n {2}node_type: memory\n {2}type: feedback\n {2}topic_key: spanish-tu\n {2}originSessionId: session-1\n {2}modified: 2026-09-25T10:00:00\.\d{3}Z\n---\n\nReply in Spanish with tú, never voseo\.\n$/);
  assert.equal(host.files.get(`${MEMORY_DIR}/MEMORY.md`), "- [Merge email](merge-email.md) — use the noreply address\n- [Spanish with tú](spanish-tu.md) — Reply in Spanish with tú, never voseo.\n", "the old line kept, one pointer added");

  const spooled = spoolFiles(host);
  assert.equal(spooled.length, 1, "one item, now in done/");
  assert.match(spooled[0] ?? "", new RegExp(`^${MEMORY_SPOOL_ROOT}/session-1/done/[0-9a-f-]{36}\\.json$`));
  assert.equal(JSON.parse(host.files.get(spooled[0] ?? "") ?? "{}").state, "done");
  const livePath = (spooled[0] ?? "").replace("/done/", "/");
  assert.ok(order.indexOf(livePath) >= 0, "the item was written to the live spool");
  assert.ok(order.indexOf(livePath) < order.indexOf(`${MEMORY_DIR}/spanish-tu.md`), "spooled before the memory file");
  assert.ok(order.indexOf(`${MEMORY_DIR}/spanish-tu.md`) < order.indexOf(`${MEMORY_DIR}/MEMORY.md`), "the file before its index line");
  assert.equal([...host.files.keys()].some((path) => path.includes(".memory-backup")), false, "a new file needs no backup");

  const row = memoryRows(host)[0];
  assert.equal(row?.mode, "active");
  assert.equal(row?.effective, "active");
  assert.equal(row?.backend, "absent");
  assert.equal(row?.fork, "drafted");
  assert.equal(row?.forkSampled, true);
  assert.deepEqual(writesOf(row), { spooled: 1, written: 1, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: false });
  assert.doesNotMatch(JSON.stringify(row), /Spanish|vos|tú|spanish-tu/, "no memory text, title or file name in the row");
});

test("A4 memory active, Engram configured but down: the file is tagged pending_engram and its item stays parked for the Engram replay", async () => {
  const host = activeHost({ down: true });
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  await activeTurn(host);
  assert.match(host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "", /\n {2}pending_engram: true\n/);
  assert.match(host.files.get(`${MEMORY_DIR}/MEMORY.md`) ?? "", /\(spanish-tu\.md\)/);
  const spooled = spoolFiles(host);
  assert.equal(spooled.length, 1);
  assert.doesNotMatch(spooled[0] ?? "", /\/done\//, "parked in the live folder until Engram can take it");
  assert.equal(JSON.parse(host.files.get(spooled[0] ?? "") ?? "{}").state, "fallback");
  const row = memoryRows(host)[0];
  assert.equal(row?.backend, "configured-down");
  assert.equal(row?.effective, "active");
  assert.deepEqual(writesOf(row), { spooled: 1, written: 1, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: false });
});

test("E2 memory active with Engram's check refused (no permission rule): it keeps measuring as Shadow, writes nothing, and the row says effective shadow", async () => {
  const host = activeHost({ engram: true });
  host.mcpAnswer = () => {
    throw new Error("Claude requested permissions to use mcp__engram__mem_current_project, but you haven't granted it yet.");
  };
  host.modelQueue.push(GATE_UPDATE, GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const seeded = new Set(host.files.keys());
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(true) });
  await runTimers(host);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(false) });
  await runTimers(host);
  assert.equal(host.forkCalls.length, 1, "Shadow's sample: the second UPDATE is not drafted");
  const rows = memoryRows(host);
  assert.deepEqual(rows.map((row) => [row.mode, row.effective, row.fork]), [["active", "shadow", "drafted"], ["active", "shadow", "not-sampled"]]);
  for (const row of rows) assert.deepEqual(writesOf(row), { spooled: 0, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: false });
  assertNothingWritten(host, seeded);
});

test("A4 memory active: a malformed gate, a draft that is not one and a fork with no answer write nothing, and each is counted", async () => {
  const cases: { gate: unknown; fork: unknown | null; expect: { gate: string; fork: string | null } }[] = [
    { gate: { isAnswered: true, text: "MAYBE, it depends", usage: USAGE(900, 4) }, fork: null, expect: { gate: "malformed", fork: null } },
    { gate: GATE_UPDATE, fork: { isAnswered: true, text: "I would remember the Spanish rule.", usage: USAGE(12, 40, 180_000) }, expect: { gate: "update", fork: "unparsable" } },
    { gate: GATE_UPDATE, fork: { isAnswered: false, reason: "refused" }, expect: { gate: "update", fork: "no-answer" } },
  ];
  for (const { gate, fork, expect } of cases) {
    const host = activeHost();
    host.modelQueue.push(gate);
    if (fork !== null) host.forkQueue.push(fork);
    const seeded = new Set(host.files.keys());
    await activeTurn(host);
    const row = memoryRows(host)[0];
    const label = JSON.stringify(expect);
    assert.equal(row?.gate, expect.gate, label);
    assert.equal(row?.fork, expect.fork, label);
    assert.equal(row?.effective, "active", label);
    assert.deepEqual(writesOf(row), { spooled: 0, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: false }, label);
    assertNothingWritten(host, seeded);
  }
});

test("A4 memory active: an update copies the file byte for byte to .memory-backup, then rewrites it; a save of an existing topic does the same", async () => {
  const cases: { reply: unknown; text: RegExp }[] = [
    { reply: draftReply({ updates: [{ name: "merge-email.md", content: DRAFT_UPDATE_TEXT }] }), text: /merge-bot@example\.com/ },
    { reply: draftReply({ saves: [{ type: "feedback", title: "Merge email", content: "Use the numbered noreply address.", topic_key: "merge-email" }] }), text: /numbered noreply/ },
  ];
  for (const { reply, text } of cases) {
    const host = activeHost();
    host.modelQueue.push(GATE_UPDATE);
    host.forkQueue.push(reply);
    const original = host.files.get(MERGE_EMAIL_PATH) ?? "";
    const order = recordWrites(host);
    await activeTurn(host);
    const backups = [...host.files.keys()].filter((path) => path.startsWith(`${MEMORY_DIR}/.memory-backup/`));
    assert.equal(backups.length, 1, "one backup");
    assert.match(backups[0] ?? "", /\/memory\/\.memory-backup\/2026-09-25T10-00-00-\d{3}Z\/merge-email\.md$/, "hidden in the memory folder, one folder per pass");
    assert.equal(host.files.get(backups[0] ?? ""), original, "the backup is the old file, byte for byte");
    assert.ok(order.indexOf(backups[0] ?? "") < order.indexOf(MERGE_EMAIL_PATH), "copied before the rewrite");
    assert.match(host.files.get(MERGE_EMAIL_PATH) ?? "", text);
    const row = memoryRows(host)[0];
    assert.equal(row?.updated, 1);
    assert.equal(row?.backups, 1);
    assert.equal(row?.written, 0, "nothing new was created");
    assert.equal(host.files.get(`${MEMORY_DIR}/MEMORY.md`)?.split("\n").filter((line) => line.includes("(merge-email.md)")).length, 1, "one pointer, never two");
  }
});

test("A4 memory active: an update of a missing file or without frontmatter is refused; a failed backup rewrites nothing", async () => {
  const refused = activeHost();
  refused.modelQueue.push(GATE_UPDATE);
  refused.forkQueue.push(draftReply({ updates: [{ name: "nowhere.md", content: DRAFT_UPDATE_TEXT }, { name: "merge-email.md", content: "Just the new text, no frontmatter." }] }));
  const seeded = new Set(refused.files.keys());
  const original = refused.files.get(MERGE_EMAIL_PATH);
  await activeTurn(refused);
  assert.equal(refused.files.get(MERGE_EMAIL_PATH), original);
  assert.equal(refused.files.has(`${MEMORY_DIR}/nowhere.md`), false);
  assert.deepEqual(writesOf(memoryRows(refused)[0]), { spooled: 0, written: 0, updated: 0, backups: 0, dropped: 2, writeFailures: 0, lockHeld: false });
  assertNothingWritten(refused, seeded);

  const noCopy = activeHost();
  memoryShell(noCopy, { failCopy: true });
  noCopy.modelQueue.push(GATE_UPDATE);
  noCopy.forkQueue.push(draftReply({ updates: [{ name: "merge-email.md", content: DRAFT_UPDATE_TEXT }] }));
  await activeTurn(noCopy);
  assert.equal(noCopy.files.get(MERGE_EMAIL_PATH), original, "no backup, no rewrite");
  assert.deepEqual(writesOf(memoryRows(noCopy)[0]), { spooled: 0, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 1, lockHeld: false });
});

test("A4 memory active: deletes are never applied in this release; they are counted as would-delete", async () => {
  const host = activeHost();
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(draftReply({ deletes: ["merge-email.md"] }));
  const seeded = new Set(host.files.keys());
  await activeTurn(host);
  assert.equal(host.files.has(MERGE_EMAIL_PATH), true);
  assert.equal(memoryRows(host)[0]?.wouldDelete, 1);
  assertNothingWritten(host, seeded);
});

test("A4 memory active: while Claude Code's consolidation holds the folder nothing is written and the save stays spooled", async () => {
  const host = activeHost();
  memoryShell(host, { alive: true });
  host.files.set(`${MEMORY_DIR}/.consolidate-lock`, "4242");
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const memoryBefore = new Map([...host.files].filter(([path]) => path.startsWith(MEMORY_DIR)));
  await activeTurn(host);
  for (const [path, text] of memoryBefore) assert.equal(host.files.get(path), text, path);
  assert.equal([...host.files.keys()].filter((path) => path.startsWith(MEMORY_DIR)).length, memoryBefore.size, "no new memory file");
  assert.ok(host.processCalls.includes("kill -0 4242"), "the lock's pid was checked");
  const spooled = spoolFiles(host);
  assert.equal(spooled.length, 1);
  assert.doesNotMatch(spooled[0] ?? "", /\/done\//);
  assert.equal(JSON.parse(host.files.get(spooled[0] ?? "") ?? "{}").state, "pending", "kept for the next replay");
  assert.deepEqual(writesOf(memoryRows(host)[0]), { spooled: 1, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: true });
});

test("A4 memory active: a subagent's turn or a turn that did not end with an answer does nothing", async () => {
  for (const extra of [{ agentId: "a-1" }, { reason: "aborted", isAborted: true }, { reason: "error" }]) {
    const host = activeHost();
    host.modelQueue.push(GATE_UPDATE);
    host.forkQueue.push(DRAFT_REPLY);
    const seeded = new Set(host.files.keys());
    const { handlers, engine } = loadHooks(host);
    const result = await completeTurn(handlers, engine, { turnId: turnIdWhere(false), ...extra });
    await runTimers(host);
    const label = JSON.stringify(extra);
    assert.equal(result, TURN_RESULT, label);
    assert.equal(host.modelCalls.length, 0, label);
    assert.equal(host.forkCalls.length, 0, label);
    assert.equal(host.files.has(MEMORY_ROWS_PATH), false, label);
    assertNothingWritten(host, seeded);
  }
});

// ---------------------------------------------------------------------------
// The spool replay at session.start (odd/tasks/memory-active-files.md, A5):
// after the backend is detected, Active on the files store finishes the saves
// its folder's spool still holds, in planReplay's order. A save writes the
// same file and the same index line however often it is replayed.
// ---------------------------------------------------------------------------

const SPANISH_SAVE = { type: "feedback" as const, title: "Spanish with tú", content: "Reply in Spanish with tú, never voseo.", topic_key: "spanish-tu" };

/** A save another session spooled and never finished (it crashed), as the mod writes it. */
function seedSpooledSave(host: FakeHost, sessionId: string, id: string, at: string): string {
  const queued = enqueueSave(SPANISH_SAVE, { id, sessionId, now: at }, MEMORY_SPOOL_ROOT);
  for (const op of queued.ops) if (op.kind === "write") host.files.set(op.path, op.content);
  return spoolItemPath(MEMORY_SPOOL_ROOT, sessionId, id);
}

function replayRows(host: FakeHost): Record<string, unknown>[] {
  return memoryRows(host).filter((row) => row.event === "replay");
}

function memoryFolder(host: FakeHost): Map<string, string> {
  return new Map([...host.files].filter(([path]) => path.startsWith(MEMORY_DIR)));
}

test("A5 memory active: a save a crashed session left in the spool is written once at the next start; a second start adds nothing", async () => {
  const host = activeHost();
  const live = seedSpooledSave(host, "session-0", "crashed-1", "2026-09-25T09:00:00.000Z");
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);

  assert.match(host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "", /\n {2}originSessionId: session-0\n/, "written for the session that drafted it");
  assert.equal(host.files.get(`${MEMORY_DIR}/MEMORY.md`)?.split("\n").filter((line) => line.includes("(spanish-tu.md)")).length, 1);
  assert.equal(host.files.has(live), false);
  assert.equal(JSON.parse(host.files.get(spoolDonePath(MEMORY_SPOOL_ROOT, "session-0", "crashed-1")) ?? "{}").state, "done");
  const rows = replayRows(host);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], at: "x", account: "x" }, {
    at: "x",
    account: "x",
    project: "sandbox",
    event: "replay",
    mode: "active",
    effective: "active",
    sessionId: "session-1",
    backend: "absent",
    decidedBy: "none",
    permission: "unknown",
    items: 1,
    replayed: 1,
    superseded: 0,
    written: 1,
    updated: 0,
    backups: 0,
    writeFailures: 0,
    lockHeld: false,
    engramSaved: 0,
    engramFailed: 0,
    mirrored: 0,
    judged: 0,
    judgePending: 0,
    judgeUnavailable: 0,
    judgeFailed: 0,
    judgeTokens: { input: 0, output: 0 },
    replayedToEngram: 0,
    fallbackRemoved: 0,
    fallbackMirrored: 0,
  });
  assert.equal(host.modelCalls.length, 0, "a replay asks no model");

  const after = memoryFolder(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  assert.deepEqual(memoryFolder(host), after, "a second replay changes nothing");
  assert.equal(replayRows(host).length, 1, "and logs nothing, since it found nothing to do");
});

test("A5 memory active: a save the lock held back is finished at the next start; another session's fresh item is left to it", async () => {
  const host = activeHost();
  memoryShell(host, { alive: true });
  host.files.set(`${MEMORY_DIR}/.consolidate-lock`, "4242");
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const running = seedSpooledSave(host, "session-9", "running-1", "2026-09-25T09:59:00.000Z");
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  assert.equal(replayRows(host).length, 0, "nothing of this folder is due: the other session's item is a minute old");
  await completeTurn(handlers, engine, { turnId: turnIdWhere(false) });
  await runTimers(host);
  assert.equal(host.files.has(`${MEMORY_DIR}/spanish-tu.md`), false, "held back by the lock");
  assert.equal(memoryRows(host).at(-1)?.lockHeld, true);

  host.files.delete(`${MEMORY_DIR}/.consolidate-lock`);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  assert.match(host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "", /\n {2}originSessionId: session-1\n/);
  assert.equal(host.files.has(running), true, "a session that moved a minute ago may still be running: its item is its own");
  const last = replayRows(host).at(-1);
  assert.equal(last?.replayed, 1);
  assert.equal(last?.written, 1);
});

test("A5 memory: Shadow, and Active with Engram's check refused, replay nothing", async () => {
  for (const [modules, engram] of [[{ memory: "shadow" }, false], [{ memory: "active" }, true]] as const) {
    const host = memoryHost({ engram });
    if (engram) {
      host.mcpAnswer = () => {
        throw new Error("Claude requested permissions to use mcp__engram__mem_current_project, but you haven't granted it yet.");
      };
    }
    setModules(host, modules);
    memoryShell(host);
    const live = seedSpooledSave(host, "session-0", "crashed-1", "2026-09-25T09:00:00.000Z");
    const seeded = new Set(host.files.keys());
    const { handlers, engine } = loadHooks(host);
    await startSessionWith(handlers, engine);
    await runTimers(host);
    const label = JSON.stringify(modules);
    assert.equal(host.files.has(live), true, label);
    assert.equal(host.files.has(`${MEMORY_DIR}/spanish-tu.md`), false, label);
    assert.equal(replayRows(host).length, 0, label);
    assertNothingWritten(host, seeded);
  }
});

// ---------------------------------------------------------------------------
// Memory in Active with Engram live (odd/tasks/memory-active-engram.md, E2):
// every UPDATE is drafted; each save is spooled, then saved with mem_save;
// user and feedback are mirrored as a file with its engram_id; Engram's
// conflict candidates are judged by Haiku from the two texts alone, recorded
// with mem_judge when clear and left pending otherwise; a failed save falls
// back to the 0.9.0 file; a turn whose main thread saved to Engram writes
// nothing of the fork's. The Engram below is a fake on `host.mcpAnswer`.
// ---------------------------------------------------------------------------

/** MEMORY_ENGRAM_TIMEOUT_MS in hooks/index.ts: a sleep of this length is the Engram call's clock. */
const ENGRAM_TIMEOUT_MS = 10_000;
const ENGRAM_2_TOOLS = ["mem_save", "mem_current_project", "mem_judge", "mem_get_observation", "mem_search"].map((tool) => ({ name: `mcp__engram__${tool}`, description: "", mcp: true }));
const PROJECT_SAVE = { type: "project", title: "Billing migration", content: "Billing moves to Stripe in Q4.", topic_key: "billing-migration" };
const REFERENCE_SAVE = { type: "reference", title: "Ops runbook", content: "The runbook lives in the ops wiki.", topic_key: "ops-runbook" };

interface CandidateSeed {
  readonly id: number;
  readonly title: string;
  readonly type: string;
  readonly content: string;
  readonly judgment_id: string;
}

interface FakeEngramStore {
  readonly observations: Map<string, { id: number; title: string; type: string; content: string }>;
  /** What mem_save answers: Engram 2.x's envelope, an older Engram's plain text, a tool error, a rejection, or never. */
  saveMode: "ok" | "old" | "error" | "reject" | "hang";
  /** The conflict candidates every successful 2.x save reports. */
  candidates: CandidateSeed[];
  readonly judged: Record<string, unknown>[];
  /** The spool files on disk when each mem_save came in. */
  readonly spoolAtSave: string[][];
  nextId: number;
}

function mcpTextResult(value: unknown, isError = false): unknown {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError };
}

/** A small Engram behind `$.mcp.call`: mem_save upserts by topic_key, mem_get_observation answers the seeded candidates, mem_judge records. */
function fakeEngram(host: FakeHost): FakeEngramStore {
  const engram: FakeEngramStore = { observations: new Map(), saveMode: "ok", candidates: [], judged: [], spoolAtSave: [], nextId: 500 };
  host.mcpAnswer = (_server: string, tool: string, args?: Record<string, unknown>): unknown => {
    if (tool === "mem_current_project") return mcpTextResult({ project: "sandbox" });
    if (tool === "mem_save") {
      engram.spoolAtSave.push(spoolFiles(host));
      if (engram.saveMode === "reject") throw new Error("connection closed");
      if (engram.saveMode === "hang") return new Promise(() => {});
      if (engram.saveMode === "error") return mcpTextResult("Failed to save: database is locked", true);
      const title = String(args?.title);
      const type = String(args?.type);
      if (engram.saveMode === "old") return mcpTextResult(`Memory saved: "${title}" (${type})`);
      const key = String(args?.topic_key);
      const id = engram.observations.get(key)?.id ?? engram.nextId++;
      engram.observations.set(key, { id, title, type, content: String(args?.content) });
      const candidates = engram.candidates.map((seed) => ({ id: seed.id, sync_id: `obs-${seed.id}`, title: seed.title, type: seed.type, score: -2, judgment_id: seed.judgment_id }));
      const conflict = candidates.length > 0 ? { judgment_required: true, judgment_id: candidates[0]?.judgment_id, candidates } : { judgment_required: false };
      return mcpTextResult({ project: "sandbox", result: `Memory saved: "${title}" (${type})`, id, ...conflict });
    }
    if (tool === "mem_get_observation") {
      const seed = engram.candidates.find((candidate) => candidate.id === args?.id);
      if (seed === undefined) return mcpTextResult(`Observation #${String(args?.id)} not found`, true);
      return mcpTextResult({ project: "sandbox", result: `#${seed.id} [${seed.type}] ${seed.title}\n${seed.content}\nSession: s-old\nCreated: 2026-09-01` });
    }
    if (tool === "mem_judge") {
      engram.judged.push({ ...args });
      return mcpTextResult({ relation: { judgment_id: args?.judgment_id } });
    }
    throw new Error(`fake Engram: unexpected tool ${tool}`);
  };
  return engram;
}

function engramActiveHost(tools: { name: string; description: string; mcp: boolean }[] = ENGRAM_2_TOOLS): { host: FakeHost; engram: FakeEngramStore } {
  const host = activeHost({ engram: true });
  host.toolList = [...tools];
  return { host, engram: fakeEngram(host) };
}

function engramCounts(row: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    engramSaved: row?.engramSaved,
    engramFailed: row?.engramFailed,
    mirrored: row?.mirrored,
    judged: row?.judged,
    judgePending: row?.judgePending,
    judgeUnavailable: row?.judgeUnavailable,
    judgeFailed: row?.judgeFailed,
    droppedMainSaved: row?.droppedMainSaved,
  };
}

const NO_ENGRAM_COUNTS = { engramSaved: 0, engramFailed: 0, mirrored: 0, judged: 0, judgePending: 0, judgeUnavailable: 0, judgeFailed: 0, droppedMainSaved: 0 };

function engramSaveCalls(host: FakeHost): { server: string; tool: string; args?: Record<string, unknown> }[] {
  return host.mcpCalls.filter((call) => call.tool === "mem_save");
}

test("E2 memory active, Engram live: the save is spooled, saved to Engram with the main thread's args, mirrored as a file with its engram_id, and the item ends in done/", async () => {
  const { host, engram } = engramActiveHost();
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  const { result } = await activeTurn(host);

  assert.equal(result, TURN_RESULT, "next(e)'s result is handed back as it was");
  assert.equal(host.forkCalls.length, 1, "Active drafts every UPDATE, sampled or not");
  assert.deepEqual(engramSaveCalls(host), [{ server: "engram", tool: "mem_save", args: { title: "Spanish with tú", content: "Reply in Spanish with tú, never voseo.", type: "policy", topic_key: "spanish-tu", capture_prompt: false } }]);
  assert.equal(engram.spoolAtSave[0]?.length, 1, "the item was on disk before mem_save");
  assert.doesNotMatch(engram.spoolAtSave[0]?.[0] ?? "", /\/done\//);

  const mirror = host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "";
  assert.match(mirror, /\n {2}topic_key: spanish-tu\n {2}engram_id: 500\n/, "a mirror of the observation");
  assert.doesNotMatch(mirror, /pending_engram/);
  assert.match(host.files.get(`${MEMORY_DIR}/MEMORY.md`) ?? "", /^- \[Spanish with tú\]\(spanish-tu\.md\)/m, "in MEMORY.md, so every session reads it");

  const spooled = spoolFiles(host);
  assert.equal(spooled.length, 1);
  assert.match(spooled[0] ?? "", /\/done\/[0-9a-f-]{36}\.json$/);
  const item = JSON.parse(host.files.get(spooled[0] ?? "") ?? "{}") as Record<string, unknown>;
  assert.deepEqual([item.state, item.store, item.engramId, item.candidates], ["done", "engram", "500", []]);

  const row = memoryRows(host)[0];
  assert.deepEqual([row?.mode, row?.effective, row?.backend], ["active", "active", "live"]);
  assert.deepEqual(engramCounts(row), { ...NO_ENGRAM_COUNTS, engramSaved: 1, mirrored: 1 });
  assert.deepEqual([row?.spooled, row?.written, row?.writeFailures], [1, 1, 0]);
  assert.doesNotMatch(JSON.stringify(row), /Spanish|vos|tú|spanish-tu/, "no memory text, title or file name in the row");
});

test("E2 memory active, Engram live: project and reference saves go to Engram only; the memory folder is untouched", async () => {
  const { host, engram } = engramActiveHost();
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(draftReply({ saves: [PROJECT_SAVE, REFERENCE_SAVE], updates: [{ name: "merge-email.md", content: DRAFT_UPDATE_TEXT }] }));
  const before = memoryFolder(host);
  await activeTurn(host);
  assert.deepEqual(engramSaveCalls(host).map((call) => [call.args?.topic_key, call.args?.type]), [["billing-migration", "discovery"], ["ops-runbook", "discovery"]]);
  assert.equal(engram.observations.size, 2);
  assert.deepEqual(memoryFolder(host), before, "no file, no index line, and no file update while Engram is the store");
  assert.ok(spoolFiles(host).every((path) => path.includes("/done/")));
  const row = memoryRows(host)[0];
  assert.deepEqual(engramCounts(row), { ...NO_ENGRAM_COUNTS, engramSaved: 2 });
  assert.deepEqual([row?.spooled, row?.written, row?.updated, row?.dropped], [2, 0, 0, 1]);
});

test("E2 memory active, Engram live: a rejected, failed or timed-out mem_save writes the fallback file and leaves the item parked", async () => {
  for (const mode of ["reject", "error", "hang"] as const) {
    const { host, engram } = engramActiveHost();
    engram.saveMode = mode;
    if (mode === "hang") host.resolveSleepMs = ENGRAM_TIMEOUT_MS;
    host.modelQueue.push(GATE_UPDATE);
    host.forkQueue.push(DRAFT_REPLY);
    const { result } = await activeTurn(host);
    assert.equal(result, TURN_RESULT, mode);
    assert.equal(engramSaveCalls(host).length, 1, `${mode}: one attempt in the pass`);
    const copy = host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "";
    assert.match(copy, /\n {2}pending_engram: true\n/, mode);
    assert.doesNotMatch(copy, /engram_id/, mode);
    assert.match(host.files.get(`${MEMORY_DIR}/MEMORY.md`) ?? "", /\(spanish-tu\.md\)/, mode);
    const spooled = spoolFiles(host);
    assert.equal(spooled.length, 1, mode);
    assert.doesNotMatch(spooled[0] ?? "", /\/done\//, `${mode}: parked in the live folder`);
    const item = JSON.parse(host.files.get(spooled[0] ?? "") ?? "{}") as Record<string, unknown>;
    assert.deepEqual([item.state, item.engramFailed], ["fallback", true], mode);
    const row = memoryRows(host)[0];
    assert.deepEqual(engramCounts(row), { ...NO_ENGRAM_COUNTS, engramFailed: 1 }, mode);
    assert.deepEqual([row?.spooled, row?.written, row?.effective], [1, 1, "active"], mode);
  }
});

test("E2 memory active, Engram live: when the main thread saved to Engram in the same turn, the fork's saves are dropped and nothing is written", async () => {
  const { host } = engramActiveHost();
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(draftReply({ saves: [SPANISH_SAVE, PROJECT_SAVE] }));
  const before = memoryFolder(host);
  const { handlers, engine } = loadHooks(host);
  await startSessionWith(handlers, engine);
  await runTimers(host);
  const answer = { result: mcpTextResult({ id: 9, judgment_required: false }) };
  await mainToolCall(handlers, engine, "mcp__engram__mem_save", { title: "Spanish with tú", type: "policy", content: "x" }, answer);
  await completeTurn(handlers, engine, { turnId: turnIdWhere(false) });
  await runTimers(host);
  assert.equal(host.forkCalls.length, 1, "the draft is still made, so the drop is measured");
  assert.deepEqual(engramSaveCalls(host), [], "the module saves nothing to Engram");
  assert.deepEqual(spoolFiles(host), [], "nothing spooled");
  assert.deepEqual(memoryFolder(host), before, "nothing written");
  const row = memoryRows(host)[0];
  assert.deepEqual(engramCounts(row), { ...NO_ENGRAM_COUNTS, droppedMainSaved: 2 });
  assert.deepEqual([row?.mainEngramSaves, row?.spooled, row?.written], [1, 0, 0]);
});

function judgeReply(relation: string, confidence: number): unknown {
  return { isAnswered: true, text: JSON.stringify({ relation, confidence, reason: "r" }), usage: USAGE(300, 20) };
}

test("E2 memory active, Engram live: conflict candidates are judged from the two texts alone; clear verdicts go to mem_judge, the rest stay pending", async () => {
  const { host, engram } = engramActiveHost();
  engram.candidates = [
    { id: 11, title: "Language notes", type: "discovery", content: "The owner writes in Spanish.", judgment_id: "rel-11" },
    { id: 12, title: "Spanish with vos", type: "policy", content: "Talk to the owner in Spanish with vos.", judgment_id: "rel-12" },
    { id: 13, title: "Tone", type: "discovery", content: "Keep a neutral tone.", judgment_id: "rel-13" },
    { id: 14, title: "Language decision", type: "decision", content: "All replies in English.", judgment_id: "rel-14" },
    { id: 15, title: "Garbled", type: "discovery", content: "Something else.", judgment_id: "rel-15" },
  ];
  host.modelQueue.push(
    GATE_UPDATE,
    judgeReply("related", 0.9),
    judgeReply("supersedes", 0.95),
    judgeReply("compatible", 0.5),
    judgeReply("conflicts_with", 0.9),
    { isAnswered: true, text: "I am not sure", usage: USAGE(300, 5) },
  );
  host.forkQueue.push(DRAFT_REPLY);
  await activeTurn(host);

  assert.deepEqual(host.mcpCalls.filter((call) => call.tool === "mem_get_observation").map((call) => call.args), [{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }, { id: 15 }], "each candidate's text, read only");
  const judges = host.modelCalls.slice(1);
  assert.equal(judges.length, 5, "one Haiku judge per candidate");
  for (const call of judges) {
    assert.equal(call.model, "haiku");
    const prompt = String(call.prompt);
    assert.match(prompt, /<new>\nTitle: Spanish with tú\nType: policy\nReply in Spanish with tú, never voseo\.\n<\/new>/);
    assert.match(prompt, /<existing>\nTitle: /);
    assert.doesNotMatch(prompt, /respóndeme|Entendido/, "never the session's own text");
  }
  assert.match(String(judges[1]?.prompt), /<existing>\nTitle: Spanish with vos\nType: policy\nTalk to the owner in Spanish with vos\.\n<\/existing>/);
  assert.deepEqual(engram.judged, [
    { judgment_id: "rel-11", relation: "related", confidence: 0.9, reason: "r" },
    { judgment_id: "rel-12", relation: "supersedes", confidence: 0.95, reason: "r" },
  ], "the clear verdicts, each with its own judgment_id (a feedback superseding a feedback is the owner's exception)");
  const row = memoryRows(host)[0];
  assert.deepEqual(engramCounts(row), { ...NO_ENGRAM_COUNTS, engramSaved: 1, mirrored: 1, judged: 2, judgePending: 2, judgeFailed: 1 });
  assert.deepEqual(row?.judgeTokens, { input: 1500, output: 85 });
  const item = JSON.parse(host.files.get(spoolFiles(host)[0] ?? "") ?? "{}") as Record<string, unknown>;
  assert.equal(Array.isArray(item.candidates) ? item.candidates.length : -1, 5, "the spool item keeps the candidates");
  assert.doesNotMatch(JSON.stringify(row), /vos|Garbled|rel-1/, "no title or judgment id in the row");
});

test("E2 memory active, Engram live without mem_judge: candidates are counted unavailable; no Haiku judge, no read, no mem_judge", async () => {
  const { host, engram } = engramActiveHost(ENGRAM_2_TOOLS.filter((tool) => !tool.name.endsWith("__mem_judge")));
  engram.candidates = [
    { id: 11, title: "Language notes", type: "discovery", content: "x", judgment_id: "rel-11" },
    { id: 12, title: "Spanish with vos", type: "policy", content: "y", judgment_id: "rel-12" },
  ];
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  await activeTurn(host);
  assert.equal(host.modelCalls.length, 1, "the gate only");
  assert.deepEqual(host.mcpCalls.map((call) => call.tool), ["mem_current_project", "mem_save"]);
  assert.deepEqual(engramCounts(memoryRows(host)[0]), { ...NO_ENGRAM_COUNTS, engramSaved: 1, mirrored: 1, judgeUnavailable: 2 });
});

test("E2 memory active, an older Engram (1.12.0: no health tool, no mem_judge): its plain answer is a save, mirrored without an id", async () => {
  const tools = ["mem_save", "mem_search", "mem_context"].map((tool) => ({ name: `mcp__plugin_engram_engram__${tool}`, description: "", mcp: true }));
  const { host, engram } = engramActiveHost(tools);
  engram.saveMode = "old";
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(DRAFT_REPLY);
  await activeTurn(host);
  assert.deepEqual(host.mcpCalls.map((call) => [call.server, call.tool]), [["plugin_engram_engram", "mem_save"]]);
  const mirror = host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "";
  assert.match(mirror, /\n {2}topic_key: spanish-tu\n/);
  assert.doesNotMatch(mirror, /engram_id|pending_engram/);
  assert.ok(spoolFiles(host).every((path) => path.includes("/done/")));
  const row = memoryRows(host)[0];
  assert.deepEqual([row?.effective, row?.decidedBy], ["active", "tools"]);
  assert.deepEqual(engramCounts(row), { ...NO_ENGRAM_COUNTS, engramSaved: 1, mirrored: 1 });
});

// ---------------------------------------------------------------------------
// The replay into Engram (odd/tasks/memory-active-engram.md, E3): a save
// parked as a fallback copy while Engram was down is saved to Engram at the
// next session start that finds it usable; the copy then becomes a mirror
// (user, feedback) or is removed after a byte-for-byte backup (project,
// reference), but only while it is still the item's own copy.
// ---------------------------------------------------------------------------

/** A turn with Engram configured but down: the draft's saves are parked as fallback copies. Then Engram comes back for the next start. */
async function parkedWhileDown(saves: unknown[]): Promise<{ host: FakeHost; handlers: Map<string, Hook>; engine: unknown; engram: () => FakeEngramStore }> {
  const host = activeHost({ down: true });
  host.modelQueue.push(GATE_UPDATE);
  host.forkQueue.push(draftReply({ saves }));
  const { handlers, engine } = await activeTurn(host);
  assert.equal(spoolFiles(host).filter((path) => !path.includes("/done/")).length, saves.length, "every save parked");
  return {
    host,
    handlers,
    engine,
    engram: () => {
      host.toolList = [...ENGRAM_2_TOOLS];
      return fakeEngram(host);
    },
  };
}

test("E3 replay into Engram: parked fallback copies are saved at the next start; feedback becomes a mirror, project is removed after a backup; a second start changes nothing", async () => {
  const { host, handlers, engine, engram } = await parkedWhileDown([SPANISH_SAVE, PROJECT_SAVE]);
  const projectCopy = host.files.get(`${MEMORY_DIR}/billing-migration.md`) ?? "";
  assert.match(projectCopy, /\n {2}pending_engram: true\n/);
  engram();
  await startSessionWith(handlers, engine);
  await runTimers(host);

  assert.deepEqual(engramSaveCalls(host).map((call) => call.args?.topic_key).sort(), ["billing-migration", "spanish-tu"]);
  const mirror = host.files.get(`${MEMORY_DIR}/spanish-tu.md`) ?? "";
  assert.match(mirror, /\n {2}engram_id: 50\d\n/, "the feedback copy is now a mirror");
  assert.doesNotMatch(mirror, /pending_engram/);
  assert.equal(host.files.has(`${MEMORY_DIR}/billing-migration.md`), false, "the project copy is gone: Engram has it");
  const index = host.files.get(`${MEMORY_DIR}/MEMORY.md`) ?? "";
  assert.doesNotMatch(index, /billing-migration/, "its line went with it");
  assert.match(index, /\(spanish-tu\.md\)/);
  const backups = [...host.files.keys()].filter((path) => path.startsWith(`${MEMORY_DIR}/.memory-backup/`));
  assert.ok(backups.some((path) => path.endsWith("/billing-migration.md") && host.files.get(path) === projectCopy), "the removed copy was backed up byte for byte first");
  assert.ok(host.processCalls.some((call) => call.startsWith("cp -p ") && call.includes("/billing-migration.md")));
  assert.ok(spoolFiles(host).every((path) => path.includes("/done/")), "both items settled");
  const row = replayRows(host).at(-1);
  assert.deepEqual(
    { backend: row?.backend, replayed: row?.replayed, engramSaved: row?.engramSaved, replayedToEngram: row?.replayedToEngram, fallbackMirrored: row?.fallbackMirrored, fallbackRemoved: row?.fallbackRemoved, writeFailures: row?.writeFailures },
    { backend: "live", replayed: 2, engramSaved: 2, replayedToEngram: 2, fallbackMirrored: 1, fallbackRemoved: 1, writeFailures: 0 },
  );

  const after = memoryFolder(host);
  const saves = engramSaveCalls(host).length;
  const rows = replayRows(host).length;
  await startSessionWith(handlers, engine);
  await runTimers(host);
  assert.deepEqual(memoryFolder(host), after, "a second replay changes nothing");
  assert.equal(engramSaveCalls(host).length, saves, "and saves nothing again");
  assert.equal(replayRows(host).length, rows, "and logs nothing");
});

test("E3 replay into Engram: a fallback file changed since it was written is left as it is, with its MEMORY.md line", async () => {
  const { host, handlers, engine, engram } = await parkedWhileDown([PROJECT_SAVE]);
  const path = `${MEMORY_DIR}/billing-migration.md`;
  const edited = (host.files.get(path) ?? "").replace("  pending_engram: true\n", "");
  host.files.set(path, edited);
  engram();
  await startSessionWith(handlers, engine);
  await runTimers(host);
  assert.equal(engramSaveCalls(host).length, 1, "Engram still gets the save");
  assert.equal(host.files.get(path), edited, "the file is not the item's own copy any more");
  assert.match(host.files.get(`${MEMORY_DIR}/MEMORY.md`) ?? "", /\(billing-migration\.md\)/);
  assert.ok(spoolFiles(host).every((file) => file.includes("/done/")));
  const row = replayRows(host).at(-1);
  assert.deepEqual([row?.replayedToEngram, row?.fallbackRemoved, row?.fallbackMirrored], [1, 0, 0]);
});

test("E3 replay into Engram: a save that fails again stays parked with its copy, and is not counted as replayed", async () => {
  const { host, handlers, engine, engram } = await parkedWhileDown([PROJECT_SAVE]);
  const before = memoryFolder(host);
  engram().saveMode = "reject";
  await startSessionWith(handlers, engine);
  await runTimers(host);
  assert.equal(engramSaveCalls(host).length, 1, "one attempt");
  assert.deepEqual(memoryFolder(host), before, "the copy stays");
  const live = spoolFiles(host).filter((file) => !file.includes("/done/"));
  assert.equal(live.length, 1, "the item stays parked");
  const row = replayRows(host).at(-1);
  assert.deepEqual([row?.engramFailed, row?.replayedToEngram, row?.replayed, row?.writeFailures], [1, 0, 0, 0]);
});
