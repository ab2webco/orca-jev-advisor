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
import test from "node:test";

import { register } from "./hooks/index.ts";

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
  readonly fetchCalls: { url: string }[];
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

const HOME = "/Users/dev";
const CONFIG_DIR = `${HOME}/.config/orca-supervisor`;
const CACHE_DIR = `${HOME}/.cache/orca-supervisor`;
const CWD = "/Users/dev/Projects/sandbox";
const SKILL_MEASUREMENTS_PATH = `${CACHE_DIR}/mod-skills-measurements.jsonl`;
const TOOL_MEASUREMENTS_PATH = `${CACHE_DIR}/mod-tools-measurements.jsonl`;

/** Builds a fake `$` (EngineInterface) backed by `host`'s mutable state. */
function makeFakeEngine(host: FakeHost): unknown {
  let clockNow = Date.parse("2026-09-25T10:00:00.000Z");
  return {
    session: {
      cwd: async () => CWD,
      messages: async () => {
        if (host.failMessages) throw new Error("fake host: session.messages failed");
        return host.messages;
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
        return content;
      },
      write: async (path: string, text: string) => {
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
      now: async () => clockNow++,
      // Never resolves: every race in these tests (Jev's own budget, and
      // resolveOrcaContext's process-run timeout) is won by the other side
      // (a fake fetch/process.run that always settles on its own), so a
      // sleep that never resolves never wins and never introduces flakiness.
      sleep: async () => new Promise<void>(() => {}),
    },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        host.fetchCalls.push({ url });
        void init;
        const next = host.fetchQueue.shift();
        if (next === undefined) throw new Error("fake fetch: response queue exhausted -- a test queued fewer canned Jev answers than the code under test called");
        const response: FakeHttpResponse = { ok: true, status: 200, headers: {}, text: JSON.stringify(next) };
        return response;
      },
    },
    process: {
      // No real `orca` binary: resolveOrcaContext falls back to its
      // cwd-only shape, deterministically, on any non-success exit.
      run: async () => {
        if (host.failProcess) throw new Error("fake host: process.run failed");
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    },
    tool: { list: async () => host.toolList },
    ui: { status: (text: string | undefined) => { host.statusLines.push(text); } },
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

  // The roll's own `$.clock.now()` call (building `today`) is the very
  // first clock read of the whole prompt.submit run -- fail only that one
  // call, so everything after the roll (timestamps inside the two
  // closures, should either of them still run) keeps behaving normally.
  const baseEngine = engine as { clock: { now: () => Promise<number> } };
  const originalNow = baseEngine.clock.now.bind(baseEngine.clock);
  let callCount = 0;
  baseEngine.clock.now = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error("clock unavailable");
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
      ? "/Users/dev/Library/Application Support/orca/claude-accounts/acct0003-1234/auth"
      : name === "HOME"
        ? HOME
        : undefined;

  const event = turnStepEvent();
  const result = turnStepResult();
  async function* fakeNext(): AsyncGenerator<unknown, unknown> {
    return result;
  }

  await drainTurnStep(hook(engine, event, fakeNext) as AsyncGenerator<unknown, unknown>);

  assert.equal(lastTurnUsageLine(host).account, "acct0003-1234");
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

// ---------------------------------------------------------------------------
// JEV-060 slice 2, T6: the model router's session-start decision (point A)
// and its stickiness, on the same turn.step hook as the usage recorder.
// ---------------------------------------------------------------------------

const ACCOUNT_DIR = "/orca/claude-accounts/acct-1/auth";
const ROUTER_DECISIONS_PATH = `${CACHE_DIR}/model-router-decisions-${TURN_USAGE_HOUR}.jsonl`;

const SEED_MODELS = [
  { id: "claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1", rank: 1, agentModel: "fable", source: "", available: false },
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", rank: 2, agentModel: "opus", source: "", available: true },
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5", rank: 3, agentModel: "sonnet", source: "", available: true },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Claude Haiku 4.5", rank: 4, agentModel: "haiku", source: "", available: true },
];

function seedRouterAccount(host: FakeHost, vaultEnv: Record<string, string> = {}): void {
  host.env.set("CLAUDE_CONFIG_DIR", ACCOUNT_DIR);
  host.files.set(`${ACCOUNT_DIR}/settings.json`, JSON.stringify({ env: vaultEnv }));
  host.files.set(`${CONFIG_DIR}/models-catalog.json`, JSON.stringify({ active: false, ready: false, models: SEED_MODELS }));
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
  assert.equal(host.statusLines.at(-1), "jev · would use: Haiku 4.5 (stage: ask)");
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
  assert.equal(host.statusLines.at(-1), "jev · model: Haiku 4.5 (stage: ask)");

  host.messages = [...host.messages, { role: "assistant", text: "", toolUses: [] }];
  const second = await stepThrough(handlers, engine, turnStepEvent({ ...FRESH_START, index: 1 }));
  assert.equal(second.model, "claude-haiku-4-5-20251001");
  assert.equal("effort" in second, false);
  assert.equal(host.fetchCalls.length, 1, "a later step never asks Jev again");
});

test("router, active: a standard prompt runs on Sonnet at medium effort", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "implement the plan in PLAN.md", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await stepThrough(handlers, engine, turnStepEvent(FRESH_START));
  assert.equal(seen.model, "claude-sonnet-5");
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

test("router, active: a guard holds the session's own model on a sensitive prompt", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.messages = [{ role: "user", text: "deploy this to production", toolUses: [] }];
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = turnStepEvent(FRESH_START);
  assert.deepEqual(await stepThrough(handlers, engine, event), event);
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.guard, "sensitive-topic");
  assert.equal(decision?.applied, false);
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
  const manual = turnStepEvent({ index: 1, model: "claude-sonnet-5", effort: "medium" });
  assert.deepEqual(await stepThrough(handlers, engine, manual), manual);
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
  const turn3 = await playTurn(host, handlers, engine, 3, "and summarise them in one line", 4);
  assert.equal(turn3.model, "claude-haiku-4-5-20251001", "the second lower turn with a positive break-even switches");

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
  const turn3 = await playTurn(host, handlers, engine, 3, "now deploy it to production", 4);
  assert.equal(turn3.model, "claude-opus-5-5");
  assert.equal(routerDecisionLines(host)[2]?.guard, "sensitive-topic");
});

test("router, active, stage: a failure on the weaker model upgrades on the next turn, whatever Jev's confidence", async () => {
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
  assert.equal(stage?.guard, "previous-failure");
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
  const [decision] = routerDecisionLines(host);
  assert.equal(decision?.point, "subagent");
  assert.equal(decision?.applied, true);
  assert.equal(JSON.stringify(decision).includes("summarise"), false, "no prompt text in the log");
});

test("router, measure, subagent: logs, changes nothing", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooks(host);
  const event = spawnEvent();
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  assert.equal(routerDecisionLines(host)[0]?.applied, false);
});

test("router, active, subagent: an explicit model is never downgraded", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
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
  const event = spawnEvent({ prompt: "Rotate the production database credentials." });
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  assert.equal(routerDecisionLines(host)[0]?.guard, "sensitive-topic");
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

  const first = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(first.effort, "medium");

  const second = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 1, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(second.effort, "medium", "kept sticky on a later step of the same agent");
});

test("JEV-061 slice 2: an explicit parent model leaves the subagent's effort untouched", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent({ model: "sonnet" }));

  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh");
});

test("JEV-061 slice 2: a guard at spawn leaves the subagent's effort untouched", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent({ prompt: "Rotate the production database credentials." }));

  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "xhigh" }));
  assert.equal(step.effort, "xhigh");
});

test("JEV-061 slice 2: a subagent's effort is never raised, even when the chosen tier asks for more", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("complex"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  await spawnThrough(handlers, engine, spawnEvent({ parentModel: "claude-sonnet-5" }));

  // complex -> high, but this step already carries only "low".
  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-opus-5-5", effort: "low" }));
  assert.equal(step.effort, "low");
});

test("JEV-061 slice 2: measure mode changes nothing", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("standard"));
  const { handlers, engine } = loadHooks(host);
  await spawnThrough(handlers, engine, spawnEvent());

  const step = await stepThrough(handlers, engine, turnStepEvent({ agentId: "agent-1", turnId: "sub-1", index: 0, model: "claude-sonnet-5", effort: "xhigh" }));
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
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
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
// Gap G6: the destination and policy guard, from the gate's own mirrors.
// ---------------------------------------------------------------------------

function seedCatalog(host: FakeHost, kind: string, policies: unknown[] = []): void {
  host.files.set(`${CONFIG_DIR}/catalog.json`, JSON.stringify({ destinations: [{ id: "here", label: "Here", kind, worktreePath: CWD, autonomy: {} }] }));
  host.files.set(`${CONFIG_DIR}/policies.json`, JSON.stringify(policies));
}

test("G6, point A: a client-site cwd keeps the session's own model on a simple prompt", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedCatalog(host, "client-site");
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const seen = await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH);
  assert.equal(seen.model, "claude-opus-5-5");
  assert.equal(seen.effort, "xhigh");
  assert.equal(routerDecisionLines(host)[0]?.guard, "client-site");
});

test("G6, point A: a prohibits policy scoped to this destination holds the floor; a global one does not", async () => {
  const scoped = makeFakeHost();
  seedRouterAccount(scoped);
  seedCatalog(scoped, "project", [{ id: "freeze", rule: "no changes this week", kind: "prohibits", destinations: ["here"] }]);
  scoped.fetchQueue.push(tierAnswer("simple"));
  const a = loadHooksWith(scoped, { routerMode: "active" });
  assert.equal((await promptTurn(scoped, a.handlers, a.engine, 1, "hola", OPUS_XHIGH)).model, "claude-opus-5-5");
  assert.equal(routerDecisionLines(scoped)[0]?.guard, "policy");

  const global = makeFakeHost();
  seedRouterAccount(global);
  seedCatalog(global, "project", [{ id: "production", rule: "ask before production", kind: "requires_human" }]);
  global.fetchQueue.push(tierAnswer("simple"));
  const b = loadHooksWith(global, { routerMode: "active" });
  assert.equal((await promptTurn(global, b.handlers, b.engine, 1, "hola", OPUS_XHIGH)).model, "claude-haiku-4-5-20251001");
});

test("G6, point B: a subagent spawned in a client-site keeps the parent's model", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  seedCatalog(host, "client-site");
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const event = spawnEvent();
  assert.deepEqual(await spawnThrough(handlers, engine, event), event);
  assert.equal(routerDecisionLines(host)[0]?.guard, "client-site");
});

test("G6, point C: a sticky model below the session's is restored once the cwd resolves to a client site", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"), tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  assert.equal((await promptTurn(host, handlers, engine, 1, "hola", OPUS_XHIGH)).model, "claude-haiku-4-5-20251001");
  seedCatalog(host, "client-site");
  const second = await promptTurn(host, handlers, engine, 2, "thanks", OPUS_XHIGH);
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(routerDecisionLines(host)[1]?.guard, "client-site");
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

test("N2: an engine-started turn after a failing test restores the session's own model, without asking Jev", async () => {
  const host = makeFakeHost();
  seedRouterAccount(host);
  host.fetchQueue.push(tierAnswer("simple"));
  const { handlers, engine } = loadHooksWith(host, { routerMode: "active" });
  const first = await promptTurn(host, handlers, engine, 1, "run the tests in the background", OPUS_XHIGH, FAILED_TESTS);
  assert.equal(first.model, "claude-haiku-4-5-20251001");
  const calls = host.fetchCalls.length;
  // A subagent finished: the engine starts turn 2 by itself, no new prompt.
  const engineTurn = await stepThrough(handlers, engine, turnStepEvent({ turnId: "turn-2", index: 0, ...OPUS_XHIGH }));
  assert.equal(engineTurn.model, "claude-opus-5-5");
  assert.equal(engineTurn.effort, "xhigh");
  assert.equal(host.fetchCalls.length, calls, "no Jev call on an engine-started turn");
  const restore = routerDecisionLines(host)[1];
  assert.equal(restore?.reason, "floor-restore");
  assert.equal(restore?.guard, "previous-failure");
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

test("JEV-061: a notification after a failing test restores the floor without asking Jev", async () => {
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
  const note = await promptTurn(host, handlers, engine, 2, "Task finished: the background tests are still failing.", OPUS_XHIGH);
  assert.equal(note.model, "claude-opus-5-5", "the floor is restored");
  assert.equal(note.effort, "xhigh");
  assert.equal(host.fetchCalls.length, calls, "no Jev call for the notification");
  const restore = routerDecisionLines(host).at(-1);
  assert.equal(restore?.reason, "floor-restore");
  assert.equal(restore?.guard, "previous-failure");
  assert.equal(restore?.origin, "task-notification");
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
