// The memory module (odd/tasks/memory-core.md, M4): the spool state machine.
// The core returns operations and Engram calls; this file runs them against a
// plain Map standing in for the disk and a small Engram that upserts by
// topic_key (its documented behaviour), so every path can be driven to its end
// and every crash point can be replayed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { detectMemoryBackend } from "./memory_detect.ts";
import type { MemoryBackendDecision, MemorySignals } from "./memory_detect.ts";
import type { DraftSave } from "./memory_draft.ts";
import {
  engramSaveArgs,
  enqueueSave,
  nextAction,
  parseMemSaveResult,
  parseSpoolItem,
  planReplay,
  REPLAY_STALE_MS,
  completeEngramSave,
  spoolDonePath,
  spoolItemPath,
  supersedeItem,
} from "./memory_spool.ts";
import type { FileOp, MemSaveOutcome, SpoolContext, SpoolItem, Transition } from "./memory_spool.ts";

const NONE: MemorySignals = { liveServer: null, health: null, userConfigured: false, pluginEnabled: false, binaryVersion: null };
const LIVE = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "ok" });
const DOWN = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "failed" });
const REFUSED = detectMemoryBackend({ ...NONE, liveServer: "engram", health: "permission" });
const ABSENT = detectMemoryBackend(NONE);

const ROOT = "/cfg/memory-spool";
const DIR = "/acct/projects/-r-app/memory";
const SESSION = "11111111-2222-3333-4444-555555555555";

const FEEDBACK: DraftSave = { type: "feedback", title: "Spanish with tú", content: "Use tú, never voseo.", topic_key: "language-es" };
const PROJECT: DraftSave = { type: "project", title: "Billing migration", content: "Billing moves to Stripe in Q4.", topic_key: "billing-migration" };

function enqueue(save: DraftSave, id: string, now = "2026-10-12T10:00:00.000Z", sessionId = SESSION): Transition {
  return enqueueSave(save, { id, sessionId, now }, ROOT);
}

// ---------------------------------------------------------------------------
// A tiny disk and a tiny Engram
// ---------------------------------------------------------------------------

type Disk = Map<string, string>;

function applyOps(disk: Disk, ops: readonly FileOp[]): void {
  for (const op of ops) {
    if (op.kind === "write") disk.set(op.path, op.content);
    else if (op.kind === "remove") disk.delete(op.path);
    else {
      const content = disk.get(op.from);
      if (content !== undefined) {
        disk.set(op.to, content);
        disk.delete(op.from);
      }
    }
  }
}

interface FakeEngram {
  up: boolean;
  /** Observations by topic_key: Engram upserts, so a repeated save is one observation. */
  readonly observations: Map<string, { id: number; title: string; content: string; type: string }>;
  saves: number;
  nextId: number;
}

function newEngram(up = true): FakeEngram {
  return { up, observations: new Map(), saves: 0, nextId: 100 };
}

function engramSave(engram: FakeEngram, args: ReturnType<typeof engramSaveArgs>): MemSaveOutcome {
  engram.saves += 1;
  if (!engram.up) return { ok: false, kind: "rejected", error: "connection closed" };
  const key = args.topic_key;
  const known = engram.observations.get(key);
  const id = known === undefined ? engram.nextId++ : known.id;
  engram.observations.set(key, { id, title: args.title, content: args.content, type: args.type });
  return { ok: true, engramId: String(id), candidates: [] };
}

interface Run {
  readonly disk: Disk;
  readonly engram: FakeEngram;
  backend: MemoryBackendDecision;
  /** Stops the run after this many steps (an operation or an Engram call), as a crash would. */
  crashAfter: number | null;
  steps: number;
}

class Crash extends Error {}

function step(run: Run): void {
  if (run.crashAfter !== null && run.steps >= run.crashAfter) throw new Crash("crash");
  run.steps += 1;
}

function contextFor(run: Run, now = "2026-10-12T10:05:00.000Z"): SpoolContext {
  return { backend: run.backend, spoolRoot: ROOT, autoMemoryDir: DIR, index: run.disk.get(`${DIR}/MEMORY.md`) ?? "", now };
}

/** The context with the item's auto-memory file as it is on the disk now, as the mod reads it before each step. */
function withCopy(run: Run, item: SpoolItem): SpoolContext {
  return { ...contextFor(run), copy: run.disk.get(`${DIR}/${item.save.topic_key}.md`) ?? null };
}

function applyStepwise(run: Run, ops: readonly FileOp[]): void {
  for (const op of ops) {
    step(run);
    applyOps(run.disk, [op]);
  }
}

/** Drives one item until nothing is left to do now. Reads the item back from the disk after every transition, as a new process would. */
function drive(run: Run, itemPath: string, item: SpoolItem): SpoolItem {
  let current = item;
  for (let guard = 0; guard < 20; guard += 1) {
    const action = nextAction(current, withCopy(run, current));
    if (action.kind === "none") return current;
    if (action.kind === "apply") {
      applyStepwise(run, action.transition.ops);
      current = action.transition.item;
    } else {
      step(run);
      const outcome = engramSave(run.engram, action.args);
      const done = completeEngramSave(current, outcome, contextFor(run));
      applyStepwise(run, done.ops);
      current = done.item;
      // One Engram attempt per item per pass: a failed replay waits for the next pass.
      if (!outcome.ok && current.state === "fallback") return current;
    }
    const live = run.disk.get(itemPath);
    if (live === undefined) return current;
    const reread = parseSpoolItem(live);
    assert.notEqual(reread, null, "the persisted item must read back");
    if (reread !== null) current = reread;
  }
  throw new Error("the state machine did not settle");
}

function newRun(backend: MemoryBackendDecision, engram = newEngram(backend.backend === "live")): Run {
  return { disk: new Map(), engram, backend, crashAfter: null, steps: 0 };
}

function start(run: Run, save: DraftSave, id = "item-1"): { path: string; item: SpoolItem } {
  const first = enqueue(save, id);
  applyOps(run.disk, first.ops);
  return { path: spoolItemPath(ROOT, SESSION, id), item: first.item };
}

const donePath = (id = "item-1"): string => spoolDonePath(ROOT, SESSION, id);
const fileOf = (save: DraftSave): string => `${DIR}/${save.topic_key}.md`;

test("the module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./memory_spool.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

// ---------------------------------------------------------------------------
// Items and paths
// ---------------------------------------------------------------------------

test("enqueue: the item is written to its own file before anything else is attempted", () => {
  const first = enqueue(FEEDBACK, "abc");
  assert.equal(first.item.state, "pending");
  assert.deepEqual(first.ops.map((op) => op.kind), ["write"]);
  const op = first.ops[0];
  assert.ok(op !== undefined && op.kind === "write");
  if (op !== undefined && op.kind === "write") {
    assert.equal(op.path, `${ROOT}/${SESSION}/abc.json`);
    assert.deepEqual(parseSpoolItem(op.content), first.item);
  }
});

test("paths: one file per item, the done folder beside them, unsafe characters in ids made harmless", () => {
  assert.equal(spoolItemPath("/s", "sess", "id1"), "/s/sess/id1.json");
  assert.equal(spoolDonePath("/s", "sess", "id1"), "/s/sess/done/id1.json");
  assert.equal(spoolItemPath("/s", "../../etc", "../x"), "/s/______etc/___x.json");
});

test("parseSpoolItem: a good item round-trips, anything malformed is null", () => {
  const item = enqueue(FEEDBACK, "abc").item;
  assert.deepEqual(parseSpoolItem(JSON.stringify(item)), item);
  const bad: unknown[] = [
    "",
    "{ nope",
    "[]",
    { ...item, state: "weird" },
    { ...item, version: 2 },
    { ...item, id: "../x" },
    { ...item, sessionId: "a/b" },
    { ...item, save: { ...item.save, type: "decision" } },
    { ...item, save: { ...item.save, topic_key: "Not A Slug" } },
    { ...item, save: { ...item.save, content: "" } },
    { ...item, attempts: -1 },
    { ...item, store: "disk" },
  ];
  for (const value of bad) assert.equal(parseSpoolItem(typeof value === "string" ? value : JSON.stringify(value)), null, JSON.stringify(value));
});

test("Engram args: the draft's title, content and topic_key, a documented type, no prompt capture", () => {
  const args = engramSaveArgs(enqueue(FEEDBACK, "a").item, "my-project");
  assert.deepEqual(args, { title: "Spanish with tú", content: "Use tú, never voseo.", type: "policy", topic_key: "language-es", capture_prompt: false, project: "my-project" });
  assert.equal("project" in engramSaveArgs(enqueue(FEEDBACK, "a").item, undefined), false);
  const types = (["user", "feedback", "project", "reference"] as const).map((type) => engramSaveArgs(enqueue({ ...FEEDBACK, type }, "a").item, undefined).type);
  assert.deepEqual(types, ["learning", "policy", "discovery", "discovery"]);
});

// ---------------------------------------------------------------------------
// No Engram: auto-memory is the one store
// ---------------------------------------------------------------------------

test("absent: pending -> written -> done, the file and the index line written, the item moved to done", () => {
  const run = newRun(ABSENT);
  const { path, item } = start(run, FEEDBACK);
  const end = drive(run, path, item);
  assert.equal(end.state, "done");
  const file = run.disk.get(fileOf(FEEDBACK)) ?? "";
  assert.match(file, /type: feedback/);
  assert.match(file, /topic_key: language-es/);
  assert.match(file, /\n {2}node_type: memory\n/, "the engine's own metadata");
  assert.match(file, /\n {2}modified: 2026-10-12T10:05:00\.000Z\n/, "stamped with the pass's clock");
  assert.doesNotMatch(file, /pending_engram|engram_id/);
  assert.match(run.disk.get(`${DIR}/MEMORY.md`) ?? "", /\[Spanish with tú\]\(language-es\.md\)/);
  assert.equal(run.disk.has(path), false, "no longer in the live folder");
  assert.equal(parseSpoolItem(run.disk.get(donePath()) ?? "")?.state, "done");
  assert.equal(run.engram.saves, 0, "Engram is never called when it is absent");
});

test("absent: every type is written to auto-memory", () => {
  for (const type of ["user", "feedback", "project", "reference"] as const) {
    const run = newRun(ABSENT);
    const save = { ...FEEDBACK, type, topic_key: `k-${type}` };
    const { path, item } = start(run, save);
    drive(run, path, item);
    assert.ok(run.disk.has(`${DIR}/k-${type}.md`), type);
  }
});

// ---------------------------------------------------------------------------
// Engram live: store of record, mirror for feedback and user
// ---------------------------------------------------------------------------

test("live feedback: pending -> written -> done, saved in Engram first, then mirrored with its engram_id", () => {
  const run = newRun(LIVE);
  const { path, item } = start(run, FEEDBACK);
  const end = drive(run, path, item);
  assert.equal(end.state, "done");
  assert.equal(end.store, "engram");
  assert.equal(end.engramId, "100");
  assert.equal(run.engram.observations.get("language-es")?.type, "policy");
  const mirror = run.disk.get(fileOf(FEEDBACK)) ?? "";
  assert.match(mirror, /engram_id: 100/);
  assert.doesNotMatch(mirror, /pending_engram/);
  assert.ok(run.disk.has(donePath()));
});

test("live user: mirrored too", () => {
  const run = newRun(LIVE);
  const save = { ...FEEDBACK, type: "user" as const, topic_key: "role" };
  const { path, item } = start(run, save);
  drive(run, path, item);
  assert.ok(run.disk.has(`${DIR}/role.md`));
});

test("live project and reference: Engram only, no auto-memory file and no index change", () => {
  for (const type of ["project", "reference"] as const) {
    const run = newRun(LIVE);
    const save = { ...PROJECT, type };
    const { path, item } = start(run, save);
    const end = drive(run, path, item);
    assert.equal(end.state, "done", type);
    assert.equal(run.engram.observations.size, 1);
    assert.equal(run.disk.has(fileOf(save)), false, type);
    assert.equal(run.disk.has(`${DIR}/MEMORY.md`), false, type);
  }
});

test("live: the Engram call carries the item's args and nothing is written to auto-memory before it answers", () => {
  const run = newRun(LIVE);
  const { item } = start(run, FEEDBACK);
  const action = nextAction(item, contextFor(run));
  assert.equal(action.kind, "engram-save");
  if (action.kind === "engram-save") {
    assert.equal(action.replay, false);
    assert.equal(action.args.topic_key, "language-es");
  }
});

// ---------------------------------------------------------------------------
// Engram fails: fallback copy, then replay
// ---------------------------------------------------------------------------

test("a failed Engram save leaves the item pending and the failure recorded; the next action is the fallback copy", () => {
  const run = newRun(LIVE, newEngram(false));
  const { item } = start(run, FEEDBACK);
  const failed = completeEngramSave(item, { ok: false, kind: "rejected", error: "connection closed" }, contextFor(run));
  assert.equal(failed.item.state, "pending");
  assert.equal(failed.item.engramFailed, true);
  assert.equal(failed.item.attempts, 1);
  assert.deepEqual(failed.item.lastFailure, { kind: "failed", message: "connection closed" });
  const action = nextAction(failed.item, contextFor(run));
  assert.equal(action.kind, "apply");
  if (action.kind === "apply") assert.equal(action.transition.item.state, "fallback");
});

test("a permission refusal is recorded as a permission failure, not a down one", () => {
  const run = newRun(LIVE);
  const { item } = start(run, FEEDBACK);
  const refused = completeEngramSave(item, { ok: false, kind: "rejected", error: "Claude requested permissions to use mcp__engram__mem_save, but you haven't granted it yet." }, contextFor(run));
  assert.equal(refused.item.lastFailure?.kind, "permission");
});

test("fallback then replay (feedback): the copy is tagged pending_engram, then becomes the mirror, state replayed", () => {
  const engram = newEngram(false);
  const run = newRun(LIVE, engram);
  const { path, item } = start(run, FEEDBACK);
  const waiting = drive(run, path, item);
  assert.equal(waiting.state, "fallback", "Engram answered with a failure");
  assert.match(run.disk.get(fileOf(FEEDBACK)) ?? "", /pending_engram: true/);
  assert.ok(run.disk.has(path), "the item stays in the live folder until Engram has it");

  engram.up = true;
  const end = drive(run, path, waiting);
  assert.equal(end.state, "replayed");
  const mirror = run.disk.get(fileOf(FEEDBACK)) ?? "";
  assert.doesNotMatch(mirror, /pending_engram/);
  assert.match(mirror, /engram_id: 100/);
  assert.equal(engram.observations.size, 1);
  assert.ok(run.disk.has(donePath()));
  assert.equal(run.disk.has(path), false);
});

test("fallback then replay (project): the auto-memory copy and its index line are removed once Engram has it", () => {
  const engram = newEngram(false);
  const run = newRun(LIVE, engram);
  const { path, item } = start(run, PROJECT);
  const waiting = drive(run, path, item);
  assert.ok(run.disk.has(fileOf(PROJECT)), "the fallback copy exists while Engram is out");
  assert.match(run.disk.get(`${DIR}/MEMORY.md`) ?? "", /billing-migration\.md/);
  engram.up = true;
  const end = drive(run, path, waiting);
  assert.equal(end.state, "replayed");
  assert.equal(run.disk.has(fileOf(PROJECT)), false);
  assert.doesNotMatch(run.disk.get(`${DIR}/MEMORY.md`) ?? "", /billing-migration/);
});

test("Engram configured but down at the time of the save: straight to the fallback copy, no Engram call", () => {
  for (const backend of [DOWN, REFUSED]) {
    const run = newRun(backend, newEngram(true));
    const { path, item } = start(run, FEEDBACK);
    const end = drive(run, path, item);
    assert.equal(end.state, "fallback");
    assert.equal(run.engram.saves, 0);
    assert.match(run.disk.get(fileOf(FEEDBACK)) ?? "", /pending_engram: true/);
  }
});

test("a fallback item waits while Engram stays unusable, and is replayed when it is usable again", () => {
  const run = newRun(DOWN, newEngram(true));
  const { path, item } = start(run, FEEDBACK);
  const waiting = drive(run, path, item);
  assert.equal(nextAction(waiting, contextFor(run)).kind, "none");
  run.backend = LIVE;
  const action = nextAction(waiting, contextFor(run));
  assert.equal(action.kind, "engram-save");
  if (action.kind === "engram-save") assert.equal(action.replay, true);
});

test("a replay that fails again keeps the item and counts the attempt; nothing is lost", () => {
  const run = newRun(LIVE, newEngram(false));
  const { path, item } = start(run, FEEDBACK);
  const waiting = drive(run, path, item);
  run.backend = LIVE;
  const again = drive(run, path, waiting);
  assert.equal(again.state, "fallback");
  assert.ok(again.attempts >= 2, `${again.attempts}`);
  assert.ok(run.disk.has(fileOf(FEEDBACK)));
  assert.ok(run.disk.has(path));
});

// ---------------------------------------------------------------------------
// Idempotency and crashes
// ---------------------------------------------------------------------------

test("double replay writes once: a second pass over the same persisted fallback state changes nothing", () => {
  const engram = newEngram(false);
  const first = newRun(LIVE, engram);
  const { path, item } = start(first, FEEDBACK);
  const waiting = drive(first, path, item);
  engram.up = true;
  const afterFirst = drive(first, path, waiting);
  const filesAfterFirst = new Map(first.disk);
  const savesAfterFirst = engram.saves;
  // Another session replays the same persisted item (its state is read from before the first replay finished).
  const second = drive(first, path, waiting);
  assert.equal(second.state, afterFirst.state);
  assert.equal(engram.observations.size, 1, "one observation, however many replays");
  assert.deepEqual([...first.disk].sort(), [...filesAfterFirst].sort(), "the same files");
  assert.ok(engram.saves - savesAfterFirst <= 1, "a stale second pass costs at most one upserting call");
});

test("a terminal item still in the live folder (a crash before the move) only needs the move", () => {
  const run = newRun(ABSENT);
  const { path, item } = start(run, FEEDBACK);
  const end = drive(run, path, item);
  const stale: SpoolItem = { ...end };
  const action = nextAction(stale, contextFor(run));
  assert.equal(action.kind, "apply");
  if (action.kind === "apply") assert.deepEqual(action.transition.ops.map((op) => op.kind), ["move"]);
});

function finalState(backendOf: () => MemoryBackendDecision, save: DraftSave, engramUp: boolean, reviveBeforeResume: boolean, crashAt: number | null) {
  const engram = newEngram(engramUp);
  const run = newRun(backendOf(), engram);
  const { path, item } = start(run, save);
  run.crashAfter = crashAt;
  let crashed = false;
  try {
    drive(run, path, item);
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
    crashed = true;
  }
  if (crashed) {
    // A new process: it knows only the disk (and Engram), reads the item back and resumes.
    run.crashAfter = null;
    if (reviveBeforeResume) engram.up = true;
    const persisted = run.disk.get(path) ?? run.disk.get(donePath());
    assert.notEqual(persisted, undefined, "the item survives the crash");
    const resumed = parseSpoolItem(persisted ?? "");
    assert.notEqual(resumed, null);
    if (resumed !== null) drive(run, path, resumed);
  }
  return { run, engram, crashed, steps: run.steps };
}

for (const [name, save, backend] of [
  ["absent, feedback", FEEDBACK, ABSENT],
  ["live, feedback", FEEDBACK, LIVE],
  ["live, project", PROJECT, LIVE],
] as const) {
  test(`crash at every step (${name}): the resumed run ends in the same files and one Engram observation per topic`, () => {
    const clean = finalState(() => backend, save, true, false, null);
    for (let crashAt = 0; crashAt <= clean.steps; crashAt += 1) {
      const crashed = finalState(() => backend, save, true, false, crashAt);
      assert.deepEqual([...crashed.run.disk].sort(), [...clean.run.disk].sort(), `files after a crash at step ${crashAt}`);
      assert.equal(crashed.engram.observations.size, clean.engram.observations.size, `observations after a crash at step ${crashAt}`);
    }
  });
}

test("crash at every step while Engram is down and comes back: the replay still ends in the clean replay's files", () => {
  const cleanEngram = newEngram(false);
  const cleanRun = newRun(LIVE, cleanEngram);
  const started = start(cleanRun, FEEDBACK);
  const waiting = drive(cleanRun, started.path, started.item);
  cleanEngram.up = true;
  drive(cleanRun, started.path, waiting);
  for (let crashAt = 0; crashAt <= 12; crashAt += 1) {
    const result = finalState(() => LIVE, FEEDBACK, false, true, crashAt);
    if (!result.crashed) continue;
    // The spool item itself differs (the resumed run may never have needed a fallback); the memory folder must not.
    const memoryFiles = (disk: Disk): [string, string][] => [...disk].filter(([path]) => path.startsWith(DIR)).sort();
    assert.deepEqual(memoryFiles(result.run.disk), memoryFiles(cleanRun.disk), `memory files after a crash at step ${crashAt}`);
    assert.equal(result.engram.observations.size, 1);
    assert.ok(result.run.disk.has(donePath()), `the item is settled after a crash at step ${crashAt}`);
  }
});

// ---------------------------------------------------------------------------
// Replay order, supersession, other sessions
// ---------------------------------------------------------------------------

function itemAt(id: string, createdAt: string, save: DraftSave, extra: Partial<SpoolItem> = {}, sessionId = SESSION): SpoolItem {
  return { ...enqueue(save, id, createdAt, sessionId).item, ...extra };
}

test("replay order: oldest first, ties by id", () => {
  const items = [
    itemAt("c", "2026-10-12T10:03:00.000Z", { ...FEEDBACK, topic_key: "c" }, { state: "fallback" }),
    itemAt("b", "2026-10-12T10:01:00.000Z", { ...FEEDBACK, topic_key: "b" }, { state: "fallback" }),
    itemAt("a", "2026-10-12T10:01:00.000Z", { ...FEEDBACK, topic_key: "a" }, { state: "fallback" }),
  ];
  const plan = planReplay(items, { currentSessionId: SESSION, now: "2026-10-12T11:00:00.000Z" });
  assert.deepEqual(plan.run.map((i) => i.id), ["a", "b", "c"]);
});

test("replay: of two items on one topic only the newest is replayed, the older one is superseded", () => {
  const older = itemAt("old", "2026-10-12T10:00:00.000Z", { ...FEEDBACK, content: "first" }, { state: "fallback" });
  const newer = itemAt("new", "2026-10-12T10:02:00.000Z", { ...FEEDBACK, content: "second" }, { state: "fallback" });
  const plan = planReplay([newer, older], { currentSessionId: SESSION, now: "2026-10-12T11:00:00.000Z" });
  assert.deepEqual(plan.run.map((i) => i.id), ["new"]);
  assert.deepEqual(plan.superseded.map((s) => [s.item.id, s.by.id]), [["old", "new"]]);
  const run = newRun(LIVE);
  const closed = supersedeItem(older, newer, contextFor(run));
  assert.equal(closed.item.state, "done");
  assert.equal(closed.item.supersededBy, "new");
  assert.deepEqual(closed.ops.map((op) => op.kind), ["write", "move"]);
});

test("replay: another session's fallback items are replayed; its fresh pending items are left to it, and stale ones are taken", () => {
  const other = "99999999-2222-3333-4444-555555555555";
  const now = "2026-10-12T10:30:00.000Z";
  const fresh = itemAt("fresh", "2026-10-12T10:29:00.000Z", { ...FEEDBACK, topic_key: "fresh" }, {}, other);
  const stale = itemAt("stale", "2026-10-12T09:00:00.000Z", { ...FEEDBACK, topic_key: "stale" }, { updatedAt: "2026-10-12T09:00:00.000Z" }, other);
  const parked = itemAt("parked", "2026-10-12T10:29:30.000Z", { ...FEEDBACK, topic_key: "parked" }, { state: "fallback" }, other);
  const mine = itemAt("mine", "2026-10-12T10:29:45.000Z", { ...FEEDBACK, topic_key: "mine" });
  const plan = planReplay([fresh, stale, parked, mine], { currentSessionId: SESSION, now });
  assert.deepEqual(plan.run.map((i) => i.id).sort(), ["mine", "parked", "stale"]);
  assert.ok(REPLAY_STALE_MS >= 60_000);
});

test("replay: terminal items found in the live folder are kept in the plan so they can be moved", () => {
  const done = itemAt("done", "2026-10-12T10:00:00.000Z", FEEDBACK, { state: "done" });
  const plan = planReplay([done], { currentSessionId: SESSION, now: "2026-10-12T11:00:00.000Z" });
  assert.deepEqual(plan.run.map((i) => i.id), ["done"]);
});

// ---------------------------------------------------------------------------
// The mem_save response (shape read from Engram's source, internal/mcp/mcp.go handleSave)
// ---------------------------------------------------------------------------

function mcpText(value: unknown, isError = false): unknown {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError };
}

test("mem_save result: the observation id, and no candidates when no judgment is required", () => {
  const outcome = parseMemSaveResult(mcpText({ project: "p", result: 'Memory saved: "t" (policy)', id: 412, sync_id: "obs-1", judgment_required: false }));
  assert.deepEqual(outcome, { ok: true, engramId: "412", candidates: [] });
});

test("mem_save result: judgment_required lists the candidates with their own judgment ids", () => {
  const outcome = parseMemSaveResult(mcpText({
    id: 413,
    judgment_required: true,
    judgment_id: "rel-aaa",
    candidates: [
      { id: 7, sync_id: "obs-7", title: "Old rule", type: "policy", score: -3.2, judgment_id: "rel-aaa", topic_key: "language-es" },
      { id: 9, sync_id: "obs-9", title: "Other", type: "discovery", score: -1.1, judgment_id: "rel-bbb" },
      { id: "bad" },
    ],
  }));
  assert.deepEqual(outcome, {
    ok: true,
    engramId: "413",
    candidates: [
      { id: 7, syncId: "obs-7", title: "Old rule", type: "policy", score: -3.2, judgmentId: "rel-aaa", topicKey: "language-es" },
      { id: 9, syncId: "obs-9", title: "Other", type: "discovery", score: -1.1, judgmentId: "rel-bbb", topicKey: null },
    ],
  });
});

test("mem_save result: a tool error is a failure with its text; an ambiguous project is told apart", () => {
  assert.deepEqual(parseMemSaveResult(mcpText("Failed to save: database is locked", true)), { ok: false, kind: "rejected", error: "Failed to save: database is locked" });
  const ambiguous = parseMemSaveResult(mcpText({ error_code: "ambiguous_project", available_projects: ["a", "b"] }, true));
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.kind, "ambiguous-project");
});

test("mem_save result: an unreadable result is a failure, never a success without an answer", () => {
  for (const value of [null, "text", {}, { content: [] }, { content: [{ type: "text", text: "not json" }], isError: false }]) {
    const outcome = parseMemSaveResult(value);
    assert.equal(outcome.ok, false, JSON.stringify(value));
  }
});

test("mem_save result: a saved answer without an id is still a success (the id is optional), with a null id", () => {
  assert.deepEqual(parseMemSaveResult(mcpText({ result: 'Memory saved: "t" (policy)', judgment_required: false })), { ok: true, engramId: null, candidates: [] });
});

// ---------------------------------------------------------------------------
// Active with Engram live (odd/tasks/memory-active-engram.md, E1)
// ---------------------------------------------------------------------------

const CANDIDATE = { id: 7, syncId: "obs-7", title: "Spanish with vos", type: "policy", score: -3.2, judgmentId: "rel-aaa", topicKey: "language-es" };

test("E1 spool: a saved item keeps the observation id and the candidates[] Engram answered with, and they read back", () => {
  const run = newRun(LIVE);
  const { item } = start(run, FEEDBACK);
  assert.deepEqual(item.candidates, [], "a new item has none");
  const saved = completeEngramSave(item, { ok: true, engramId: "413", candidates: [CANDIDATE] }, contextFor(run));
  assert.equal(saved.item.engramId, "413");
  assert.deepEqual(saved.item.candidates, [CANDIDATE]);
  const write = saved.ops.find((op) => op.kind === "write");
  assert.ok(write !== undefined && write.kind === "write");
  if (write !== undefined && write.kind === "write") assert.deepEqual(parseSpoolItem(write.content)?.candidates, [CANDIDATE], "persisted in the item's file");
  const failed = completeEngramSave(saved.item, { ok: false, kind: "rejected", error: "x" }, contextFor(run));
  assert.deepEqual(failed.item.candidates, [CANDIDATE], "a later failure keeps what was answered");
});

test("E1 spool: a 0.9.0 item, written before candidates[] existed, reads as none; malformed candidates are skipped", () => {
  const item = enqueue(FEEDBACK, "old").item;
  const older: Record<string, unknown> = { ...item };
  delete older.candidates;
  assert.deepEqual(parseSpoolItem(JSON.stringify(older))?.candidates, []);
  assert.deepEqual(parseSpoolItem(JSON.stringify({ ...item, candidates: [CANDIDATE, { id: "x" }, 3] }))?.candidates, [CANDIDATE]);
  assert.equal(parseSpoolItem(JSON.stringify({ ...item, candidates: "none" })), null, "not a list is a bad file");
});

test("E1 mem_save result: an older Engram's plain 'Memory saved:' text is a success with no id and no candidates", () => {
  assert.deepEqual(parseMemSaveResult(mcpText('Memory saved: "Spanish with tú" (policy)')), { ok: true, engramId: null, candidates: [] });
  assert.equal(parseMemSaveResult(mcpText("Something else entirely")).ok, false, "any other plain text is still unreadable");
  assert.equal(parseMemSaveResult(mcpText('Memory saved: "x" (policy)', true)).ok, false, "a tool error is never a success");
});

function parkedProjectRun(): { run: Run; path: string; waiting: SpoolItem } {
  const engram = newEngram(false);
  const run = newRun(LIVE, engram);
  const { path, item } = start(run, PROJECT);
  const waiting = drive(run, path, item);
  assert.equal(waiting.state, "fallback");
  engram.up = true;
  return { run, path, waiting };
}

test("E1 replay (project): a file that is no longer the item's own fallback copy is left, with its index line", () => {
  const edits: [string, (text: string) => string][] = [
    ["the person dropped pending_engram", (text) => text.replace("  pending_engram: true\n", "")],
    ["another session wrote it", (text) => text.replace(`originSessionId: ${SESSION}`, "originSessionId: other-session")],
    ["another topic took the name", (text) => text.replace("topic_key: billing-migration", "topic_key: billing")],
  ];
  for (const [label, edit] of edits) {
    const { run, path, waiting } = parkedProjectRun();
    const changed = edit(run.disk.get(fileOf(PROJECT)) ?? "");
    assert.notEqual(changed, run.disk.get(fileOf(PROJECT)), `${label}: the edit applies`);
    run.disk.set(fileOf(PROJECT), changed);
    const index = run.disk.get(`${DIR}/MEMORY.md`);
    const end = drive(run, path, waiting);
    assert.equal(end.state, "replayed", label);
    assert.equal(run.disk.get(fileOf(PROJECT)), changed, label);
    assert.equal(run.disk.get(`${DIR}/MEMORY.md`), index, label);
    assert.ok(run.disk.has(donePath()), `${label}: the item is still settled, Engram has it`);
  }
});

test("E1 replay (project): when the copy is already gone (a crash after its removal), only its index line goes", () => {
  const { run, path, waiting } = parkedProjectRun();
  run.disk.delete(fileOf(PROJECT));
  drive(run, path, waiting);
  assert.doesNotMatch(run.disk.get(`${DIR}/MEMORY.md`) ?? "", /billing-migration/);
  assert.ok(run.disk.has(donePath()));
});

test("E1 replay (project): without the copy's text the folder is not touched", () => {
  const { run, waiting } = parkedProjectRun();
  const saved = completeEngramSave(waiting, { ok: true, engramId: "100", candidates: [] }, contextFor(run));
  const action = nextAction(saved.item, contextFor(run));
  assert.equal(action.kind, "apply");
  if (action.kind === "apply") assert.deepEqual(action.transition.ops.filter((op) => op.kind !== "move" && !(op.kind === "write" && op.path.startsWith(ROOT))), [], "only the item's own file and its move");
});
