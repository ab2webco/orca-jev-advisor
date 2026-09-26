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

import register from "./hooks/index.ts";

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
}

function makeFakeHost(): FakeHost {
  return {
    handlers: new Map<string, Hook>(),
    files: new Map<string, string>(),
    fetchQueue: [],
    fetchCalls: [],
    toolList: [],
    statusLines: [],
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

/** Builds a fake `$` (EngineInterface) backed by `host`'s mutable state. */
function makeFakeEngine(host: FakeHost): unknown {
  let clockNow = Date.parse("2026-09-25T10:00:00.000Z");
  return {
    session: { cwd: async () => CWD },
    env: { get: async (name: string) => (name === "HOME" ? HOME : undefined) },
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
      run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
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
