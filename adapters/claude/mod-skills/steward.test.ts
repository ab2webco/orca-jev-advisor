// Integration tests for the Jev context steward's hook wiring in
// hooks/index.ts (odd/tasks/jev-context-steward.md): main `turn.complete`
// schedules a timer; the timer reads the context, asks Jev once, and
// compacts (active mode) with instructions that keep the plan. The pure
// rules are covered in src/core/context_steward.test.ts.
//
// Run with:
//   node --test --experimental-strip-types adapters/claude/mod-skills/steward.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import { register } from "./hooks/index.ts";

type Hook = (engine: unknown, event: unknown, next: (event: unknown) => unknown) => unknown;
type TimerFn = () => unknown;

interface CompactCall {
  readonly instructions: string | undefined;
}

interface FakeHost {
  readonly handlers: Map<string, Hook>;
  readonly files: Map<string, string>;
  readonly state: Map<string, unknown>;
  readonly fetchQueue: unknown[];
  readonly fetchCalls: string[];
  readonly compactCalls: CompactCall[];
  readonly statusLines: (string | undefined)[];
  readonly toasts: string[];
  timers: TimerFn[];
  messages: unknown[];
  usage: { tokens: number | undefined; percent: number | undefined; window: number };
  compactResult: { messages: unknown[]; tokensBefore?: number; tokensAfter?: number } | { skip: string } | "reject" | "headless";
}

const HOME = "/home/dev";
const VAULT = `${HOME}/.orca/claude-accounts/acct-a/auth`;
const CACHE_DIR = `${HOME}/.cache/orca-supervisor`;
const ROUTER_KEY = "orca-jev-mod-skills@skills-dir";

function makeHost(): FakeHost {
  return {
    handlers: new Map(),
    files: new Map(),
    state: new Map(),
    fetchQueue: [],
    fetchCalls: [],
    compactCalls: [],
    statusLines: [],
    toasts: [],
    timers: [],
    messages: [],
    usage: { tokens: 150_000, percent: 15, window: 1_000_000 },
    compactResult: { messages: [], tokensBefore: 150_000, tokensAfter: 30_000 },
  };
}

function makeEngine(host: FakeHost): unknown {
  let clockNow = Date.parse("2026-09-28T10:00:00.000Z");
  return {
    session: {
      cwd: async () => "/home/dev/Projects/project-c",
      root: async () => "/home/dev/Projects/project-c",
      messages: async () => host.messages,
      usage: async () => ({ startedAt: 0, context: host.usage, rateLimits: [] }),
      compact: async (args?: { instructions?: string }) => {
        host.compactCalls.push({ instructions: args?.instructions });
        if (host.compactResult === "reject") throw new Error("a turn is running");
        if (host.compactResult === "headless") throw new Error("orca-jev-mod-skills: $.session.compact: not available in a headless (-p / SDK) session yet");
        return host.compactResult;
      },
    },
    env: {
      get: async (name: string) => {
        if (name === "HOME") return HOME;
        if (name === "CLAUDE_CONFIG_DIR") return VAULT;
        return undefined;
      },
    },
    state: {
      get: async (ref: { key: string }) => ({ value: host.state.get(ref.key), version: host.state.has(ref.key) ? 1 : 0 }),
      set: async (ref: { key: string }, value: unknown) => {
        host.state.set(ref.key, value);
        return { isSet: true, version: 1 };
      },
    },
    fs: {
      exists: async (path: string) => host.files.has(path) || [...host.files.keys()].some((key) => key.startsWith(`${path}/`)),
      read: async (path: string) => {
        const content = host.files.get(path);
        if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      },
      write: async (path: string, text: string) => {
        host.files.set(path, text);
      },
      list: async () => [],
    },
    clock: {
      now: async () => clockNow++,
      sleep: async () => new Promise<void>(() => {}),
      after: (_ms: number, fn: TimerFn) => {
        host.timers.push(fn);
        return { cancel: () => undefined };
      },
    },
    http: {
      fetch: async (url: string) => {
        host.fetchCalls.push(url);
        const next = host.fetchQueue.shift();
        if (next === undefined || next === "fail") throw new Error("fake fetch: Jev unreachable");
        return { ok: true, status: 200, headers: {}, text: JSON.stringify(next) };
      },
    },
    process: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    tool: { list: async () => [] },
    ui: {
      status: (text: string | undefined) => {
        host.statusLines.push(text);
      },
      toast: (text: string) => {
        host.toasts.push(text);
      },
    },
  };
}

function load(host: FakeHost): unknown {
  const on = (...args: unknown[]): void => {
    host.handlers.set(args[0] as string, (args.length >= 3 ? args[2] : args[1]) as Hook);
  };
  register(on as never, { typesafeApiKey: "test-key" } as never);
  return makeEngine(host);
}

function setSteward(host: FakeHost, mode: string, threshold = 120_000): void {
  host.files.set(`${HOME}/.config/orca-supervisor/locale`, "es\n");
  host.files.set(`${VAULT}/settings.json`, JSON.stringify({ pluginConfigs: { [ROUTER_KEY]: { options: { stewardMode: mode, stewardThreshold: threshold } } } }));
}

function verdict(choice: string, confidence: number): unknown {
  return { model: "jev-latest", answers: { verdict: { type: "choice", choice, probabilities: {}, confidence } }, usage: { input_tokens: 1, output_tokens: 1 } };
}

/** A person prompt: prompt.submit from the composer (it may call Jev for skills: any such call fails open on an empty queue). */
async function personPrompt(host: FakeHost, engine: unknown, text: string): Promise<void> {
  const submit = host.handlers.get("prompt.submit");
  assert.ok(submit);
  await submit(engine, { text, wait: false, origin: { kind: "composer" } }, async (e: unknown) => e);
  host.fetchQueue.length = 0;
  host.fetchCalls.length = 0;
}

async function turnStart(host: FakeHost, engine: unknown, turnId: string): Promise<void> {
  const start = host.handlers.get("turn.start");
  assert.ok(start, "turn.start is registered");
  await start(engine, { text: "", turnId }, async (e: unknown) => ({ turnId: (e as { turnId: string }).turnId }));
}

async function turnComplete(host: FakeHost, engine: unknown, extra: Record<string, unknown> = {}): Promise<void> {
  const complete = host.handlers.get("turn.complete");
  assert.ok(complete, "turn.complete is registered");
  await complete(engine, { answer: "done", durationMs: 10, isAborted: false, turnId: "turn-1", reason: "answer", ...extra }, async () => ({ text: "done" }));
}

async function runTimers(host: FakeHost): Promise<void> {
  while (host.timers.length > 0) {
    const due = host.timers;
    host.timers = [];
    for (const fn of due) await fn();
  }
}

/** One whole person turn: the prompt, its turn, its end, and the steward's timer. */
async function personTurn(host: FakeHost, engine: unknown, text: string, jevAnswer: unknown): Promise<void> {
  await personPrompt(host, engine, text);
  await turnStart(host, engine, `turn-${text}`);
  if (jevAnswer !== null) host.fetchQueue.push(jevAnswer);
  await turnComplete(host, engine, { turnId: `turn-${text}` });
  await runTimers(host);
}

function stewardLog(host: FakeHost): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const [path, text] of host.files) {
    if (!path.startsWith(`${CACHE_DIR}/context-steward-decisions-`)) continue;
    for (const line of text.split("\n")) if (line.trim().length > 0) lines.push(JSON.parse(line) as Record<string, unknown>);
  }
  return lines;
}

const WORK: unknown[] = [
  { role: "user", text: "sigue odd/tasks/feature-a.md", toolUses: [] },
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "a", tool: "Bash", input: { command: "git commit -m 'feat: one'" }, text: "[feat-x 1a2b3c4] feat: one" }] },
];

test("steward, active: a confident boundary above the threshold compacts once with the preserving instructions, logs and shows it", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.messages = WORK;
  await personTurn(host, engine, "commit it", verdict("boundary", 0.85));
  assert.equal(host.compactCalls.length, 1);
  const instructions = host.compactCalls[0]?.instructions ?? "";
  for (const needle of ["odd/tasks/feature-a.md", "open checklist items", "next step", "feat-x", "1a2b3c4 feat: one (feat-x)", "pending"]) assert.ok(instructions.includes(needle), `keeps ${needle}`);
  const log = stewardLog(host);
  assert.equal(log.length, 1);
  assert.deepEqual({ ...log[0], at: "x" }, { at: "x", account: "acct-a", project: "project-c", mode: "active", contextBefore: 150_000, decision: "boundary", confidence: 0.85, compact: true, applied: true, contextAfter: 30_000, notApplied: null });
  assert.ok(host.statusLines.some((line) => line?.includes("150k → 30k (tarea cerrada)")), `status: ${host.statusLines.join(" | ")}`);
  assert.deepEqual(host.toasts, []);
});

test("steward: the Jev state carries no file contents or command output", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.messages = [{ role: "user", text: "commit it", toolUses: [] }, { role: "assistant", text: "", toolUses: [{ tool_use_id: "r", tool: "Read", input: { file_path: "src/secret-module.ts" }, text: "const SECRET_CONTENTS = 1" }] }];
  let body = "";
  const http = (engine as { http: { fetch: (url: string, init?: { body?: string }) => Promise<unknown> } }).http;
  const original = http.fetch;
  http.fetch = async (url, init) => {
    body = init?.body ?? "";
    return original(url, init);
  };
  await personTurn(host, engine, "commit it", verdict("mid-task", 0.9));
  assert.ok(body.length > 0, "Jev was asked");
  assert.ok(!body.includes("SECRET_CONTENTS"), "no file contents");
  assert.ok(!body.includes("secret-module"), "no paths");
});

test("steward, active: a confident new topic compacts and suggests /clear", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personTurn(host, engine, "otro tema", verdict("new-topic", 0.8));
  assert.equal(host.compactCalls.length, 1);
  assert.deepEqual(host.toasts, ["tarea cerrada: /clear libera todo el contexto"]);
  assert.equal(stewardLog(host)[0]?.decision, "new-topic");
});

test("steward, active: mid-task does not compact", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.9));
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host)[0]?.decision, "mid-task");
  assert.equal(stewardLog(host)[0]?.applied, false);
});

test("steward, active: a boundary below 0.70 does not compact", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personTurn(host, engine, "sigue", verdict("boundary", 0.6));
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host)[0]?.decision, "low-confidence");
});

test("steward, active: at 80% of the window it compacts even mid-task", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.usage = { tokens: 170_000, percent: 85, window: 200_000 };
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.9));
  assert.equal(host.compactCalls.length, 1);
  assert.equal(stewardLog(host)[0]?.decision, "hard-limit");
});

test("steward, active: a Jev failure means no compaction", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personTurn(host, engine, "sigue", "fail");
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host)[0]?.decision, "jev-failed");
});

test("steward, active: a Jev failure at the hard limit still compacts", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.usage = { tokens: 170_000, percent: 85, window: 200_000 };
  await personTurn(host, engine, "sigue", "fail");
  assert.equal(host.compactCalls.length, 1);
  assert.equal(stewardLog(host)[0]?.decision, "hard-limit");
});

test("steward, active: never twice within 3 person turns", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personTurn(host, engine, "uno", verdict("boundary", 0.9));
  assert.equal(host.compactCalls.length, 1);
  await personTurn(host, engine, "dos", verdict("boundary", 0.9));
  await personTurn(host, engine, "tres", verdict("boundary", 0.9));
  assert.equal(host.compactCalls.length, 1, "turns 2 and 3 after it are within the cooldown");
  await personTurn(host, engine, "cuatro", verdict("boundary", 0.9));
  assert.equal(host.compactCalls.length, 2, "the third person turn after it may compact");
});

test("steward, measure: decides and logs, compacts nothing, and says it only measures", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "measure");
  await personTurn(host, engine, "commit it", verdict("new-topic", 0.9));
  assert.equal(host.compactCalls.length, 0);
  assert.deepEqual(host.toasts, []);
  const log = stewardLog(host);
  assert.equal(log[0]?.mode, "measure");
  assert.equal(log[0]?.compact, true);
  assert.equal(log[0]?.applied, false);
  assert.equal(log[0]?.contextAfter, null);
  assert.equal(log[0]?.notApplied, "measure");
  assert.ok(host.statusLines.some((line) => line?.includes("150k → compactaría (tema nuevo · solo mide)")), `status: ${host.statusLines.join(" | ")}`);
});

test("steward: measure is the default when the account never set a mode", async () => {
  const host = makeHost();
  const engine = load(host);
  await personTurn(host, engine, "commit it", verdict("boundary", 0.9));
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host)[0]?.mode, "measure");
});

test("steward: a subagent's turn is never compacted, and asks Jev nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personPrompt(host, engine, "go");
  host.fetchQueue.push(verdict("boundary", 0.95));
  await turnComplete(host, engine, { agentId: "agent-1" });
  await runTimers(host);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(host.fetchCalls.length, 0);
  assert.deepEqual(stewardLog(host), []);
});

test("steward: below the threshold asks Jev nothing and logs nothing; the account's threshold is used", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 200_000);
  await personTurn(host, engine, "sigue", verdict("boundary", 0.95));
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(host.compactCalls.length, 0);
  assert.deepEqual(stewardLog(host), []);
});

test("steward: off does nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "off");
  await personTurn(host, engine, "sigue", verdict("boundary", 0.95));
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(host.compactCalls.length, 0);
});

test("steward: an interrupted turn is left alone", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personPrompt(host, engine, "go");
  host.fetchQueue.push(verdict("boundary", 0.95));
  await turnComplete(host, engine, { reason: "aborted", isAborted: true });
  await runTimers(host);
  assert.equal(host.compactCalls.length, 0);
});

test("steward: a new turn that started before the timer ran is never compacted under", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personPrompt(host, engine, "go");
  await turnStart(host, engine, "turn-1");
  host.fetchQueue.push(verdict("boundary", 0.95));
  await turnComplete(host, engine, { turnId: "turn-1" });
  await turnStart(host, engine, "turn-2");
  await runTimers(host);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host)[0]?.applied, false);
  assert.equal(stewardLog(host)[0]?.notApplied, "turn-running");
});

test("steward: a compaction the engine rejects is retried on a later timer, then given up; never throws", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.compactResult = "reject";
  await personTurn(host, engine, "commit it", verdict("boundary", 0.9));
  assert.equal(host.compactCalls.length, 3);
  const log = stewardLog(host);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.applied, false);
  assert.equal(log[0]?.notApplied, "rejected");
});

test("steward: a compaction a hook skipped is not applied", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.compactResult = { skip: "another plugin said no" };
  await personTurn(host, engine, "commit it", verdict("boundary", 0.9));
  assert.equal(host.compactCalls.length, 1);
  assert.equal(stewardLog(host)[0]?.applied, false);
  assert.equal(stewardLog(host)[0]?.notApplied, "skipped");
});

test("steward: a headless session, where the engine refuses compaction, is logged as such and not retried", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.compactResult = "headless";
  await personTurn(host, engine, "commit it", verdict("boundary", 0.9));
  assert.equal(host.compactCalls.length, 1);
  assert.equal(stewardLog(host)[0]?.notApplied, "headless");
});
