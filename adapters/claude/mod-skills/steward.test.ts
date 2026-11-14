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
  /** What `$.session.model()` answers (0.6.15 T4). */
  model: string;
  compactResult: { messages: unknown[]; tokensBefore?: number; tokensAfter?: number; usage?: Record<string, number> } | { skip: string } | "reject" | "headless";
  /** Track S: the fake clock, in ms; each read moves it 1 ms, and a test moves it to make a session idle. */
  clockNow: number;
  /** Track S: the plugin's own `$.store` (per account), the env the mod reads, and every timer's wait. */
  readonly store: Map<string, unknown>;
  readonly env: Map<string, string>;
  readonly timerDelays: number[];
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
    model: "claude-opus-5-5",
    compactResult: { messages: [], tokensBefore: 150_000, tokensAfter: 30_000 },
    clockNow: Date.parse("2026-09-28T10:00:00.000Z"),
    store: new Map(),
    env: new Map(),
    timerDelays: [],
  };
}

function makeEngine(host: FakeHost): unknown {
  return {
    session: {
      cwd: async () => "/home/dev/Projects/project-c",
      root: async () => "/home/dev/Projects/project-c",
      id: async () => "session-1",
      model: async () => host.model,
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
        return host.env.get(name);
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
      now: async () => host.clockNow++,
      // callJev waits through this both for its budget (seconds: never fires here) and for a retry backoff (under a second: elapses at once).
      sleep: async (ms: number) => (ms <= 1_000 ? undefined : new Promise<void>(() => {})),
      after: (ms: number, fn: TimerFn) => {
        host.timerDelays.push(ms);
        host.timers.push(fn);
        return { cancel: () => undefined };
      },
    },
    http: {
      fetch: async (url: string) => {
        host.fetchCalls.push(url);
        const next = host.fetchQueue.shift();
        if (next === undefined || next === "fail") throw new Error("fake fetch: Jev unreachable");
        // G8: "payment" answers HTTP 402, a key whose account has no credit.
        if (next === "payment") return { ok: false, status: 402, headers: {}, text: "" };
        return { ok: true, status: 200, headers: {}, text: JSON.stringify(next) };
      },
    },
    process: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
    store: {
      get: async (key: string) => host.store.get(key),
      set: async (key: string, value: unknown) => {
        host.store.set(key, value);
      },
    },
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

function setSteward(host: FakeHost, mode: string, threshold = 120_000, softMode?: string, coldMode?: string): void {
  host.files.set(`${HOME}/.config/orca-supervisor/locale`, "es\n");
  const soft = softMode === undefined ? {} : { stewardSoftMode: softMode };
  const cold = coldMode === undefined ? {} : { stewardColdMode: coldMode };
  host.files.set(`${VAULT}/settings.json`, JSON.stringify({ pluginConfigs: { [ROUTER_KEY]: { options: { stewardMode: mode, stewardThreshold: threshold, ...soft, ...cold } } } }));
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
  // 0.6.15 T4: every row also names Jev's verdict, the session, the turn, the main window, the current model and the tier.
  assert.deepEqual({ ...log[0], at: "x" }, { at: "x", account: "acct-a", project: "project-c", mode: "active", contextBefore: 150_000, decision: "boundary", confidence: 0.85, compact: true, applied: true, contextAfter: 30_000, notApplied: null, verdict: "boundary", sessionId: "session-1", turnIndex: 1, mainWindow: 1_000_000, currentModel: "claude-opus-5-5", tier: "boundary", wouldFire: null });
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
  // 0.6.15 T4: the limit follows the session's main model, here a 200k one.
  host.model = "claude-haiku-4-5";
  host.usage = { tokens: 170_000, percent: 85, window: 200_000 };
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.9));
  assert.equal(host.compactCalls.length, 1);
  assert.equal(stewardLog(host)[0]?.decision, "hard-limit");
});

test("G8: a Jev answer of 402 is logged jev-payment, and compacts nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  await personTurn(host, engine, "sigue", "payment");
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host)[0]?.decision, "jev-payment");
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
  // 0.6.15 T4: the limit follows the session's main model, here a 200k one.
  host.model = "claude-haiku-4-5";
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

// ---------------------------------------------------------------------------
// 0.6.15 T4 (JEVADV-87, odd/research/steward-1m.md): the hard limit is 80% of
// the MAIN model's window, never past 600k; a 400k soft tier ships measured.
// ---------------------------------------------------------------------------

test("steward, active: a router step on a 200k model does not trip the hard limit of a 1M session", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.state.set("routerSticky", { model: "claude-haiku-4-5", effort: null, rewrite: true, configuredModel: "claude-opus-5-5[1m]", configuredEffort: "high", tier: "simple", pendingLower: null, stats: {}, lastPrompt: null });
  host.usage = { tokens: 180_000, percent: 90, window: 200_000 };
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.9));
  assert.equal(host.compactCalls.length, 0);
  const row = stewardLog(host)[0];
  assert.equal(row?.decision, "mid-task");
  assert.equal(row?.mainWindow, 1_000_000);
  assert.equal(row?.currentModel, "claude-haiku-4-5");
});

test("steward, active: at 600k of a 1M window it compacts even mid-task", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.usage = { tokens: 620_000, percent: 62, window: 1_000_000 };
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.9));
  assert.equal(host.compactCalls.length, 1);
  assert.equal(stewardLog(host)[0]?.decision, "hard-limit");
  assert.equal(stewardLog(host)[0]?.tier, "hard-600k");
});

test("steward, active: the 400k soft tier only logs that it would fire while its switch is on measure", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.usage = { tokens: 450_000, percent: 45, window: 1_000_000 };
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.7));
  assert.equal(host.compactCalls.length, 0);
  const row = stewardLog(host)[0];
  assert.equal(row?.decision, "mid-task");
  assert.equal(row?.tier, null);
  assert.equal(row?.wouldFire, "soft-400k");
  assert.equal(row?.verdict, "mid-task");
});

test("steward, active: with the soft tier switched on it compacts at 400k unless Jev is sure the work is mid-task", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, "active");
  host.usage = { tokens: 450_000, percent: 45, window: 1_000_000 };
  await personTurn(host, engine, "uno", verdict("mid-task", 0.85));
  assert.equal(host.compactCalls.length, 0, "a sure mid-task waits");
  await personTurn(host, engine, "dos", verdict("boundary", 0.5));
  assert.equal(host.compactCalls.length, 1);
  const row = stewardLog(host)[1];
  assert.equal(row?.decision, "soft-limit");
  assert.equal(row?.tier, "soft-400k");
  assert.equal(row?.wouldFire, null);
  assert.equal(row?.verdict, "boundary", "a low-confidence verdict is logged too");
  assert.ok(host.statusLines.some((line) => line?.includes("(límite suave de 400k)")), `status: ${host.statusLines.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// Feature modules (odd/tasks/feature-modules.md, T4): the steward module's
// state is read from `<configDir>/feature-modules.json` on every hook call.
// ---------------------------------------------------------------------------

const MODULES_PATH = `${HOME}/.config/orca-supervisor/feature-modules.json`;

function setModules(host: FakeHost, modules: Record<string, string>): void {
  host.files.set(MODULES_PATH, JSON.stringify({ modules }));
}

test("T4 steward off: a turn counts nothing, schedules no timer, asks Jev nothing and compacts nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  // verify-done (0.8.0) and memory (M8) schedule their own timers; off here so the count is the steward's alone.
  setModules(host, { steward: "off", "verify-done": "off", memory: "off" });
  host.messages = WORK;
  host.fetchQueue.push(verdict("boundary", 0.95));
  const submit = host.handlers.get("prompt.submit");
  assert.ok(submit);
  await submit(engine, { text: "commit it", wait: false, origin: { kind: "composer" } }, async (e: unknown) => e);
  await turnStart(host, engine, "turn-1");
  await turnComplete(host, engine);

  assert.equal(host.timers.length, 0, "no timer is scheduled");
  await runTimers(host);
  assert.equal(host.state.has("steward"), false, "no person-turn counter");
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host).length, 0);
  assert.equal(host.fetchCalls.length, 0, "no Jev call");
});

test("T4 steward off: a timer already scheduled asks nothing once the module went off", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  // verify-done (0.8.0) and memory (M8) schedule their own timers; off here so the count is the steward's alone.
  setModules(host, { "verify-done": "off", memory: "off" });
  host.messages = WORK;
  await personPrompt(host, engine, "commit it");
  await turnStart(host, engine, "turn-1");
  host.fetchQueue.push(verdict("boundary", 0.95));
  await turnComplete(host, engine);
  assert.equal(host.timers.length, 1, "scheduled while the module was on");

  setModules(host, { steward: "off", "verify-done": "off", memory: "off" });
  await runTimers(host);
  assert.equal(host.fetchCalls.length, 0);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host).length, 0);
});

test("T4 steward shadow: an active steward and its soft tier only measure -- decided and logged, never compacted", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, "active");
  setModules(host, { steward: "shadow" });
  host.messages = WORK;
  await personTurn(host, engine, "commit it", verdict("boundary", 0.85));
  assert.equal(host.compactCalls.length, 0);
  const log = stewardLog(host);
  assert.equal(log[0]?.mode, "measure");
  assert.equal(log[0]?.compact, true);
  assert.equal(log[0]?.applied, false);
});

test("T4 steward: a switch in the file is picked up by the loaded hooks, with no reload", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.messages = WORK;
  setModules(host, { steward: "off" });
  await personTurn(host, engine, "one", verdict("boundary", 0.85));
  assert.equal(host.compactCalls.length, 0);
  setModules(host, { steward: "active" });
  await personTurn(host, engine, "commit it", verdict("boundary", 0.85));
  assert.equal(host.compactCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Track S (odd/tasks/steward-pre-cold.md): the pre-cold tier. After a main
// turn's steward timer, an idle timer is armed; a wake that is due (the fake
// clock moved) decides with the engine-coexistence rule, logs, and in active
// mode compacts while the cache is still warm. The pure rules are covered in
// src/core/steward_pre_cold.test.ts.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const ENGINE_SEEN_KEY = "engineIdleCompactSeenAt";

function preColdRows(host: FakeHost): Record<string, unknown>[] {
  return stewardLog(host).filter((row) => row.trigger === "pre-cold");
}

function eventRows(host: FakeHost): Record<string, unknown>[] {
  return stewardLog(host).filter((row) => row.event !== undefined);
}

/** Runs the timers due now once (the steward's own, which arms the idle one), without the ones they schedule. */
async function runDueOnce(host: FakeHost): Promise<void> {
  const due = host.timers;
  host.timers = [];
  for (const fn of due) await fn();
}

/** A person turn whose steward timer runs at once, then `idleMinutes` of idle before the remaining timers (the pre-cold wake) run. */
async function idleAfterTurn(host: FakeHost, engine: unknown, text: string, jevAnswer: unknown, idleMinutes: number): Promise<void> {
  await personPrompt(host, engine, text);
  await turnStart(host, engine, `turn-${text}`);
  if (jevAnswer !== null) host.fetchQueue.push(jevAnswer);
  await turnComplete(host, engine, { turnId: `turn-${text}` });
  await runDueOnce(host);
  host.clockNow += idleMinutes * MINUTE;
  await runTimers(host);
}

async function classicCompact(host: FakeHost, engine: unknown, phase: "PreCompact" | "PostCompact", trigger: string): Promise<void> {
  const hook = host.handlers.get(`classic.${phase}`);
  assert.ok(hook, `classic.${phase} is registered`);
  await hook(engine, { trigger, ...(phase === "PreCompact" ? { custom_instructions: null } : { compact_summary: "summary" }) }, async (e: unknown) => e);
}

test("S2 pre-cold, measure (the default): a due idle wake logs wouldFire, compacts nothing and leaves the turn-end steward's cooldown alone", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "measure");
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 52);
  assert.equal(host.compactCalls.length, 0);
  const rows = preColdRows(host);
  assert.equal(rows.length, 1);
  const row = rows[0] ?? {};
  assert.equal(row.decision, "pre-cold");
  assert.equal(row.mode, "measure");
  assert.equal(row.compact, true);
  assert.equal(row.applied, false);
  assert.equal(row.notApplied, "measure");
  assert.equal(row.wouldFire, "pre-cold");
  assert.equal(row.tier, "pre-cold");
  assert.equal(row.coldSkip, null);
  assert.equal(row.engineZone, false);
  assert.equal(row.contextBefore, 150_000);
  assert.equal(row.sessionId, "session-1");
  assert.ok(typeof row.idleMs === "number" && row.idleMs >= 52 * MINUTE, String(row.idleMs));
  assert.equal((host.state.get("steward") as { lastCompactionTurn: number | null }).lastCompactionTurn, null, "measure moves no cooldown");
  // The turn-end row is still there, and still alone in the turn-end numbers.
  assert.equal(stewardLog(host).filter((r) => r.trigger === undefined).length, 1);
});

test("S2 pre-cold, active: compacts with the pre-cold instructions while warm, records the result and its cost, and marks the cooldown", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  host.messages = WORK;
  host.compactResult = { messages: [], tokensBefore: 150_000, tokensAfter: 9_000, usage: { input_tokens: 8_000, output_tokens: 2_000, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 10 } };
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 52);
  assert.equal(host.compactCalls.length, 1);
  const instructions = host.compactCalls[0]?.instructions ?? "";
  assert.ok(instructions.startsWith("The session went idle"), instructions);
  assert.ok(instructions.includes("odd/tasks/feature-a.md"));
  const row = preColdRows(host)[0] ?? {};
  assert.equal(row.applied, true);
  assert.equal(row.mode, "active");
  assert.equal(row.contextAfter, 9_000);
  assert.equal(row.wouldFire, null);
  assert.equal(row.compactCost, 8_000 + 14_000 + 20 + 10_000);
  assert.equal((host.state.get("steward") as { lastCompactionTurn: number | null }).lastCompactionTurn, 1);
});

test("S2 pre-cold: the steward on active with the cold switch on measure only measures", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "measure");
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 52);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(preColdRows(host)[0]?.wouldFire, "pre-cold");
});

test("S2 pre-cold: a wake before its slot re-arms for the rest, at most three wakes, and writes nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 40);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(preColdRows(host).length, 0);
  // The first arm waits for 51 minutes; the wake at 40 asks for about 11 more.
  assert.ok(host.timerDelays.includes(51 * MINUTE), host.timerDelays.join(","));
  assert.ok(host.timerDelays.some((ms) => ms > 10 * MINUTE && ms < 12 * MINUTE), host.timerDelays.join(","));
  // The steward's and verify-done's own timers are under a second; the idle ones are minutes: three wakes at most.
  assert.ok(host.timerDelays.filter((ms) => ms >= MINUTE).length <= 3, host.timerDelays.join(","));
});

test("S2 pre-cold: the TTL the router read from the transcript sets the slot; with none it is 1h", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  host.state.set("routerCache", { ttlMs: 5 * MINUTE, lastMainAt: null });
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 1);
  assert.ok(host.timerDelays.includes(0.85 * 5 * MINUTE), host.timerDelays.join(","));
  assert.ok(!host.timerDelays.includes(51 * MINUTE), host.timerDelays.join(","));
});

test("S2 pre-cold: a turn that starts makes the armed timer do nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  await personPrompt(host, engine, "sigue");
  await turnStart(host, engine, "turn-1");
  host.fetchQueue.push(verdict("mid-task", 0.5));
  await turnComplete(host, engine, { turnId: "turn-1" });
  await runDueOnce(host);
  assert.equal(host.timers.length, 1, "armed");
  await turnStart(host, engine, "turn-2");
  host.clockNow += 52 * MINUTE;
  await runTimers(host);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(preColdRows(host).length, 0);
});

test("S2 pre-cold: a subagent's turn arms nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  await turnComplete(host, engine, { agentId: "agent-1" });
  assert.equal(host.timers.length, 0);
});

test("S2 pre-cold: below the threshold a due wake writes nothing", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 200_000, undefined, "active");
  await idleAfterTurn(host, engine, "sigue", null, 52);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(stewardLog(host).length, 0);
});

test("S2 pre-cold: the cold switch off, or the module off, arms nothing", async () => {
  for (const [cold, modules] of [["off", null], ["active", { steward: "off", "verify-done": "off" }]] as const) {
    const host = makeHost();
    const engine = load(host);
    setSteward(host, "active", 120_000, undefined, cold);
    if (modules !== null) setModules(host, modules);
    await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 52);
    assert.equal(host.compactCalls.length, 0, cold);
    assert.equal(preColdRows(host).length, 0, cold);
  }
});

test("S2 pre-cold: a confident mid-task on the last turn stands down, with a row", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.9), 52);
  assert.equal(host.compactCalls.length, 0);
  const row = preColdRows(host)[0] ?? {};
  assert.equal(row.decision, "pre-cold-skip");
  assert.equal(row.coldSkip, "mid-task");
  assert.equal(row.compact, false);
  assert.equal(row.verdict, "mid-task");
});

test("S2 pre-cold: a headless session logs the refusal once and stops arming", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  host.compactResult = "headless";
  await idleAfterTurn(host, engine, "uno", verdict("mid-task", 0.5), 52);
  assert.equal(preColdRows(host)[0]?.notApplied, "headless");
  for (const text of ["dos", "tres", "cuatro"]) await idleAfterTurn(host, engine, text, verdict("mid-task", 0.5), 52);
  assert.equal(host.compactCalls.length, 1);
  assert.equal(preColdRows(host).length, 1);
});

test("S2 engine rule: in the engine's zone with the engine seen in this account, it stands down", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  host.usage = { tokens: 190_000, percent: 19, window: 1_000_000 };
  host.store.set(ENGINE_SEEN_KEY, "2026-09-01T00:00:00.000Z");
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 56);
  assert.equal(host.compactCalls.length, 0);
  const row = preColdRows(host)[0] ?? {};
  assert.equal(row.coldSkip, "engine-owns");
  assert.equal(row.engineZone, true);
});

test("S2 engine rule: in the zone with the engine never seen, it fires only after the engine's slot", async () => {
  for (const [minutes, compactions] of [[53, 0], [56, 1]] as const) {
    const host = makeHost();
    const engine = load(host);
    setSteward(host, "active", 120_000, undefined, "active");
    host.usage = { tokens: 190_000, percent: 19, window: 1_000_000 };
    await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), minutes);
    assert.equal(host.compactCalls.length, compactions, `at ${minutes} minutes`);
    if (compactions === 1) assert.equal(preColdRows(host)[0]?.engineZone, true);
    else assert.equal(preColdRows(host).length, 0);
  }
});

test("S2 engine rule: the env override moves the engine's zone", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  host.usage = { tokens: 190_000, percent: 19, window: 1_000_000 };
  host.store.set(ENGINE_SEEN_KEY, "2026-09-01T00:00:00.000Z");
  host.env.set("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS", "300000");
  await idleAfterTurn(host, engine, "sigue", verdict("mid-task", 0.5), 52);
  assert.equal(host.compactCalls.length, 1, "190k is below 90% of 300k: the engine would not act");
});

test("S2 engine observed: an auto compaction while idle is remembered in this account, logged, and makes the wake stand down", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  host.usage = { tokens: 190_000, percent: 19, window: 1_000_000 };
  await personPrompt(host, engine, "sigue");
  await turnStart(host, engine, "turn-1");
  host.fetchQueue.push(verdict("mid-task", 0.5));
  await turnComplete(host, engine, { turnId: "turn-1" });
  await runDueOnce(host);
  host.clockNow += 54 * MINUTE;
  await classicCompact(host, engine, "PreCompact", "auto");
  await classicCompact(host, engine, "PostCompact", "auto");
  assert.equal(typeof host.store.get(ENGINE_SEEN_KEY), "string", "remembered in the plugin's store");
  assert.equal(eventRows(host)[0]?.event, "engine-idle-compact");
  host.clockNow += 2 * MINUTE;
  await runTimers(host);
  assert.equal(host.compactCalls.length, 0);
  assert.equal(preColdRows(host)[0]?.coldSkip, "engine-compacted");
});

test("S2 engine observed: a manual compaction, or one under a running turn, is not the engine's idle one", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  await personPrompt(host, engine, "sigue");
  await turnStart(host, engine, "turn-1");
  host.fetchQueue.push(verdict("mid-task", 0.5));
  await turnComplete(host, engine, { turnId: "turn-1" });
  await runDueOnce(host);
  host.clockNow += 54 * MINUTE;
  await classicCompact(host, engine, "PostCompact", "manual");
  await turnStart(host, engine, "turn-2");
  await classicCompact(host, engine, "PostCompact", "auto");
  assert.equal(host.store.has(ENGINE_SEEN_KEY), false);
  assert.equal(eventRows(host).length, 0);
});

test("S2 pre-cold: every hook returns what it was given; a failing host never throws out of the timer", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  await personPrompt(host, engine, "sigue");
  await turnStart(host, engine, "turn-1");
  host.fetchQueue.push(verdict("mid-task", 0.5));
  await turnComplete(host, engine, { turnId: "turn-1" });
  await runDueOnce(host);
  (engine as { session: { usage: () => Promise<unknown> } }).session.usage = async () => {
    throw new Error("usage unavailable");
  };
  host.clockNow += 52 * MINUTE;
  await runTimers(host);
  assert.equal(host.compactCalls.length, 0);
  for (const phase of ["PreCompact", "PostCompact"]) {
    const hook = host.handlers.get(`classic.${phase}`);
    assert.ok(hook);
    const given = { trigger: "auto", compact_summary: "s" };
    assert.equal(await hook(engine, given, async (e: unknown) => e), given);
  }
});

test("S2 engine observed: an auto PreCompact with no PostCompact (blocked or failed) does not hold the tier off after the next turn", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active", 120_000, undefined, "active");
  await personPrompt(host, engine, "uno");
  await turnStart(host, engine, "turn-uno");
  await classicCompact(host, engine, "PreCompact", "auto");
  host.fetchQueue.push(verdict("mid-task", 0.5));
  await turnComplete(host, engine, { turnId: "turn-uno" });
  await runDueOnce(host);
  host.timers = [];
  host.clockNow += 5 * MINUTE;
  await idleAfterTurn(host, engine, "dos", verdict("mid-task", 0.5), 52);
  assert.equal(host.compactCalls.length, 1);
  assert.equal(preColdRows(host)[0]?.applied, true);
});

test("steward, game mode: the /clear suggestion is published as a notice, the toast still shows, and no status line is drawn", async () => {
  const host = makeHost();
  host.env.set("ORCA_GAME_MODE", "on");
  const engine = load(host);
  setSteward(host, "active");
  await personTurn(host, engine, "otro tema", verdict("new-topic", 0.8));
  assert.deepEqual(host.toasts, ["tarea cerrada: /clear libera todo el contexto"]);
  assert.deepEqual(host.statusLines, []);
  const advisor = host.state.get("advisor") as { line: string | null; notices: { level: string; text: string }[] } | undefined;
  assert.deepEqual(advisor?.notices.map((notice) => [notice.level, notice.text]), [["info", "tarea cerrada: /clear libera todo el contexto"]]);
  assert.match(advisor?.line ?? "", /^jev · /);
});

// ---------------------------------------------------------------------------
// JEVADV-109: the settled tier, through turn.complete and the steward's timer
// ---------------------------------------------------------------------------

const SETTLED_TURN: unknown[] = [
  { role: "user", text: "sigue con odd/tasks/feature-a.md", toolUses: [] },
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "e", tool: "Edit", input: { file_path: "src/a.ts" }, text: "The file src/a.ts has been updated." }] },
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "t", tool: "Bash", input: { command: "npm test" }, text: "# pass 40\n# fail 0" }] },
  { role: "assistant", text: "Tests pass; next I wire the panel.", toolUses: [] },
];

test("JEVADV-109, active: above 200k a settled turn compacts on a confident mid-task, keeping the step in progress", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.usage = { tokens: 250_000, percent: 25, window: 1_000_000 };
  host.compactResult = { messages: [], tokensBefore: 250_000, tokensAfter: 60_000 };
  host.messages = SETTLED_TURN;
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.95));
  assert.equal(host.compactCalls.length, 1);
  const instructions = host.compactCalls[0]?.instructions ?? "";
  for (const needle of ["NOT finished", "exact next action", "odd/tasks/feature-a.md"]) assert.ok(instructions.includes(needle), `keeps ${needle}`);
  const row = stewardLog(host)[0];
  assert.deepEqual({ decision: row?.decision, tier: row?.tier, applied: row?.applied, verdict: row?.verdict, settledHold: row?.settledHold, contextAfter: row?.contextAfter }, { decision: "settled-limit", tier: "settled-200k", applied: true, verdict: "mid-task", settledHold: null, contextAfter: 60_000 });
  assert.ok(host.statusLines.some((line) => line?.includes("250k → 60k (más de 200k, entre dos pasos)")), `status: ${host.statusLines.join(" | ")}`);
});

test("JEVADV-109, active: above 200k a turn with its tests failing after the last edit is held, and the row says why", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.usage = { tokens: 250_000, percent: 25, window: 1_000_000 };
  host.messages = [...SETTLED_TURN.slice(0, 2), { role: "assistant", text: "", toolUses: [{ tool_use_id: "t", tool: "Bash", input: { command: "npm test" }, text: "✖ a fails\n# fail 1" }] }];
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.95));
  assert.equal(host.compactCalls.length, 0);
  const row = stewardLog(host)[0];
  assert.deepEqual({ decision: row?.decision, applied: row?.applied, settledHold: row?.settledHold }, { decision: "mid-task", applied: false, settledHold: "tests-failing" });
});

test("JEVADV-109, measure: the settled tier only logs what it would do", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "measure");
  host.usage = { tokens: 250_000, percent: 25, window: 1_000_000 };
  host.messages = SETTLED_TURN;
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.95));
  assert.equal(host.compactCalls.length, 0);
  const row = stewardLog(host)[0];
  assert.deepEqual({ decision: row?.decision, mode: row?.mode, compact: row?.compact, applied: row?.applied, notApplied: row?.notApplied, settledHold: row?.settledHold }, { decision: "settled-limit", mode: "measure", compact: true, applied: false, notApplied: "measure", settledHold: null });
});

test("JEVADV-109: below 200k nothing changes and the row carries no settledHold", async () => {
  const host = makeHost();
  const engine = load(host);
  setSteward(host, "active");
  host.messages = SETTLED_TURN;
  await personTurn(host, engine, "sigue", verdict("mid-task", 0.95));
  assert.equal(host.compactCalls.length, 0);
  assert.ok(!("settledHold" in (stewardLog(host)[0] ?? {})));
});
