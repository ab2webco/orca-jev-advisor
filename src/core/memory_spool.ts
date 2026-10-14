// ---------------------------------------------------------------------------
// Memory module, the spool (odd/tasks/memory-core.md, M4).
//
// A save is never lost. Before any write is attempted the item is written to
// its own file, `<spool>/<sessionId>/<id>.json` (one file per item, so there is
// no shared file to race on). Then it walks one of two paths:
//
//   Engram usable:   pending -> written -> done
//                    Engram has it (written); a feedback or user item is
//                    mirrored into auto-memory; the item moves to done/.
//   Engram can't:    pending -> fallback -> replayed
//                    The item is written to auto-memory as a copy tagged
//                    pending_engram (fallback), kept until Engram takes it.
//                    A later replay saves it to Engram (topic_key upserts, so
//                    never a duplicate); a feedback or user copy becomes the
//                    mirror, a project or reference copy is removed (replayed).
//   No Engram:       pending -> written -> done, auto-memory being the store.
//
// This file is pure: it never touches the disk or Engram. Every step returns
// the file operations to do (in order, each idempotent) and the next item,
// whose state is persisted by the last-but-one operation, so a crash between
// any two steps leaves an item whose state says what is left. `nextAction`
// from that state redoes at most one idempotent step. A caller makes at most
// one Engram attempt per item per pass, re-reads MEMORY.md before each step
// (the index text it passes in is the one the operation rewrites), and treats
// a `move` whose source is already gone as done.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { MEMORY_TYPES, routeSave } from "./memory_decide.ts";
import type { MemoryType } from "./memory_decide.ts";
import { engramUsable, isPermissionRefusal } from "./memory_detect.ts";
import type { MemoryBackendDecision } from "./memory_detect.ts";
import { memoryFileName, memoryIndexLine, removeIndexLine, renderMemoryFile, slugTopicKey, upsertIndexLine } from "./memory_draft.ts";
import type { DraftSave } from "./memory_draft.ts";
import { parseFrontmatter } from "./memory_tidy.ts";

export type SpoolState = "pending" | "written" | "done" | "fallback" | "replayed";
export const SPOOL_STATES: readonly SpoolState[] = ["pending", "written", "done", "fallback", "replayed"];

/** Terminal states: the item has nothing left to do and belongs in done/. */
export function isSettled(state: SpoolState): boolean {
  return state === "done" || state === "replayed";
}

export interface SpoolFailure {
  /** `permission`: the engine refused the call for want of a rule (not Engram being down). */
  readonly kind: "permission" | "failed";
  readonly message: string;
}

export interface SpoolItem {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly save: DraftSave;
  readonly state: SpoolState;
  /** Where the store-of-record write landed; null until it has. */
  readonly store: "engram" | "auto-memory" | null;
  /** The Engram observation id, when Engram answered with one. */
  readonly engramId: string | null;
  /** The conflict candidates Engram's `mem_save` answered with (`judgment_required`); none until it has. Items from 0.9.0 read as none. */
  readonly candidates: readonly EngramCandidate[];
  /** A pending item whose Engram attempt failed: its next step is the fallback copy. */
  readonly engramFailed: boolean;
  readonly attempts: number;
  readonly lastFailure: SpoolFailure | null;
  /** Set on an item closed because a newer save of the same topic replaced it. */
  readonly supersededBy: string | null;
}

export type FileOp =
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "move"; readonly from: string; readonly to: string }
  | { readonly kind: "remove"; readonly path: string };

/** The next item and the operations that persist it, in order. */
export interface Transition {
  readonly item: SpoolItem;
  readonly ops: readonly FileOp[];
}

export interface SpoolContext {
  readonly backend: MemoryBackendDecision;
  readonly spoolRoot: string;
  readonly autoMemoryDir: string;
  /** MEMORY.md as it is now, '' when there is none. */
  readonly index: string;
  /**
   * The item's own auto-memory file as it is now: its text, null when there is
   * none, absent when it was not read. A fallback copy is removed only when
   * this shows it is still the item's own copy.
   */
  readonly copy?: string | null;
  /** ISO time. */
  readonly now: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function safeComponent(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function spoolItemPath(root: string, sessionId: string, id: string): string {
  return `${root}/${safeComponent(sessionId)}/${safeComponent(id)}.json`;
}

export function spoolDonePath(root: string, sessionId: string, id: string): string {
  return `${root}/${safeComponent(sessionId)}/done/${safeComponent(id)}.json`;
}

// ---------------------------------------------------------------------------
// Reading an item back
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function readSave(value: unknown): DraftSave | null {
  if (!isRecord(value)) return null;
  const type = MEMORY_TYPES.find((candidate) => candidate === value.type);
  const { title, content, topic_key: topicKey } = value;
  if (type === undefined || typeof title !== "string" || title.trim() === "" || typeof content !== "string" || content.trim() === "") return null;
  if (typeof topicKey !== "string" || topicKey === "" || slugTopicKey(topicKey) !== topicKey) return null;
  return { type, title, content, topic_key: topicKey };
}

/** The candidates as the item stores them; absent (a 0.9.0 item) is none, an entry that is not one is skipped, anything but a list is a bad file. */
function readStoredCandidates(value: unknown): readonly EngramCandidate[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry): EngramCandidate[] => {
    if (!isRecord(entry)) return [];
    const { id, syncId, title, type, score, judgmentId, topicKey } = entry;
    if (typeof id !== "number" || typeof title !== "string" || typeof type !== "string" || typeof judgmentId !== "string" || judgmentId === "") return [];
    return [{ id, syncId: typeof syncId === "string" ? syncId : null, title, type, score: typeof score === "number" ? score : null, judgmentId, topicKey: typeof topicKey === "string" ? topicKey : null }];
  });
}

function readFailure(value: unknown): SpoolFailure | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || (value.kind !== "permission" && value.kind !== "failed") || typeof value.message !== "string") return undefined;
  return { kind: value.kind, message: value.message };
}

/** An item read from its file, or null for anything malformed: a bad file is never acted on. */
export function parseSpoolItem(text: string): SpoolItem | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;
  const { id, sessionId, createdAt, updatedAt, engramId, supersededBy } = value;
  const state = SPOOL_STATES.find((candidate) => candidate === value.state);
  const save = readSave(value.save);
  const failure = readFailure(value.lastFailure);
  const store = value.store;
  if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) return null;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string" || state === undefined || save === null || failure === undefined) return null;
  if (store !== null && store !== "engram" && store !== "auto-memory") return null;
  if (engramId !== null && typeof engramId !== "string") return null;
  if (supersededBy !== null && typeof supersededBy !== "string") return null;
  if (typeof value.engramFailed !== "boolean" || typeof value.attempts !== "number" || !Number.isInteger(value.attempts) || value.attempts < 0) return null;
  const candidates = readStoredCandidates(value.candidates);
  if (candidates === null) return null;
  return { version: 1, id, sessionId, createdAt, updatedAt, save, state, store, engramId, candidates, engramFailed: value.engramFailed, attempts: value.attempts, lastFailure: failure, supersededBy };
}

function serialize(item: SpoolItem): string {
  return `${JSON.stringify(item, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface EnqueueMeta {
  readonly id: string;
  readonly sessionId: string;
  readonly now: string;
}

/** Step zero: the new item and the one operation that makes it durable. Do this before any write attempt. */
export function enqueueSave(save: DraftSave, meta: EnqueueMeta, spoolRoot: string): Transition {
  const item: SpoolItem = {
    version: 1,
    id: meta.id,
    sessionId: meta.sessionId,
    createdAt: meta.now,
    updatedAt: meta.now,
    save,
    state: "pending",
    store: null,
    engramId: null,
    candidates: [],
    engramFailed: false,
    attempts: 0,
    lastFailure: null,
    supersededBy: null,
  };
  return { item, ops: [{ kind: "write", path: spoolItemPath(spoolRoot, item.sessionId, item.id), content: serialize(item) }] };
}

function livePath(item: SpoolItem, ctx: SpoolContext): string {
  return spoolItemPath(ctx.spoolRoot, item.sessionId, item.id);
}

function withState(item: SpoolItem, changes: Partial<SpoolItem>, ctx: SpoolContext): SpoolItem {
  return { ...item, ...changes, updatedAt: ctx.now };
}

function persist(item: SpoolItem, ctx: SpoolContext, before: readonly FileOp[] = []): Transition {
  return { item, ops: [...before, { kind: "write", path: livePath(item, ctx), content: serialize(item) }] };
}

/** The last step: the item's final state is written and the file moves to done/. A crash between the two leaves a settled item in the live folder, which only needs the move. */
function settle(item: SpoolItem, state: "done" | "replayed", ctx: SpoolContext, before: readonly FileOp[] = [], changes: Partial<SpoolItem> = {}): Transition {
  const next = withState(item, { ...changes, state }, ctx);
  const from = livePath(next, ctx);
  return { item: next, ops: [...before, { kind: "write", path: from, content: serialize(next) }, { kind: "move", from, to: spoolDonePath(ctx.spoolRoot, next.sessionId, next.id) }] };
}

/** Whether a save of this type is mirrored into auto-memory while Engram is the store (design 5.3): the always-on rules, feedback and user. */
export function mirrors(type: MemoryType): boolean {
  return type === "feedback" || type === "user";
}

/** Whether a memory file is still this item's own fallback copy: tagged pending_engram, written by the item's session, on the item's topic. */
export function isOwnFallbackCopy(text: string, item: SpoolItem): boolean {
  const front = parseFrontmatter(text);
  return front.pendingEngram && front.originSessionId === item.sessionId && front.topicKey === item.save.topic_key;
}

/** The auto-memory file and its index line, in that order: a crash between them leaves an unlisted file, which the next pass rewrites. */
function autoMemoryOps(item: SpoolItem, ctx: SpoolContext, options: { readonly engramId?: string; readonly pendingEngram?: boolean }): readonly FileOp[] {
  const save = item.save;
  const file = memoryFileName(save.type, save.topic_key);
  const content = renderMemoryFile(save, { originSessionId: item.sessionId, modified: ctx.now,...(options.engramId === undefined ? {} : { engramId: options.engramId }), ...(options.pendingEngram === true ? { pendingEngram: true } : {}) });
  return [
    { kind: "write", path: `${ctx.autoMemoryDir}/${file}`, content },
    { kind: "write", path: `${ctx.autoMemoryDir}/MEMORY.md`, content: upsertIndexLine(ctx.index, file, memoryIndexLine(save, file)) },
  ];
}

/** The args of `mem_save`. The type is one of Engram's own categories, since the conflict rule keys on it. */
export interface EngramSaveArgs {
  readonly title: string;
  readonly content: string;
  readonly type: string;
  readonly topic_key: string;
  readonly capture_prompt: false;
  readonly project?: string;
}

const ENGRAM_TYPE: Readonly<Record<MemoryType, string>> = {
  user: "learning",
  // A standing rule. Engram 2.1.0 accepts any type and gives `policy` its own review decay; a conflict on it
  // goes to the person, while a confident supersedes by a newer feedback is recorded (memory_judge.ts decideVerdict).
  feedback: "policy",
  project: "discovery",
  reference: "discovery",
};

/** The Engram category a memory of this type is saved as. */
export function engramTypeOf(type: MemoryType): string {
  return ENGRAM_TYPE[type];
}

export function engramSaveArgs(item: SpoolItem, project: string | undefined): EngramSaveArgs {
  const save = item.save;
  return {
    title: save.title,
    content: save.content,
    type: engramTypeOf(save.type),
    topic_key: save.topic_key,
    capture_prompt: false,
    ...(project === undefined ? {} : { project }),
  };
}

export type SpoolAction =
  | { readonly kind: "none" }
  | { readonly kind: "engram-save"; readonly args: EngramSaveArgs; readonly replay: boolean }
  | { readonly kind: "apply"; readonly transition: Transition };

/**
 * What to do next for an item found in the live folder. Settled items need
 * only the move to done/. A pending item goes to Engram when it is usable,
 * to the fallback copy when it is not (or when an attempt just failed), and
 * to auto-memory alone when there is no Engram. A fallback item waits until
 * Engram is usable, is replayed, and is then settled.
 */
export function nextAction(item: SpoolItem, ctx: SpoolContext, project?: string): SpoolAction {
  if (isSettled(item.state)) {
    return { kind: "apply", transition: { item, ops: [{ kind: "move", from: livePath(item, ctx), to: spoolDonePath(ctx.spoolRoot, item.sessionId, item.id) }] } };
  }
  const type = item.save.type;
  if (item.state === "pending") {
    const route = routeSave(type, ctx.backend);
    if (item.engramFailed || route.engram === "replay-later") {
      const copy = withState(item, { state: "fallback" }, ctx);
      return { kind: "apply", transition: persist(copy, ctx, autoMemoryOps(item, ctx, { pendingEngram: true })) };
    }
    if (route.engram === "now") return { kind: "engram-save", args: engramSaveArgs(item, project), replay: false };
    const written = withState(item, { state: "written", store: "auto-memory" }, ctx);
    return { kind: "apply", transition: persist(written, ctx, autoMemoryOps(item, ctx, {})) };
  }
  if (item.state === "written") {
    if (item.store === "engram" && mirrors(type)) {
      return { kind: "apply", transition: settle(item, "done", ctx, autoMemoryOps(item, ctx, item.engramId === null ? {} : { engramId: item.engramId })) };
    }
    return { kind: "apply", transition: settle(item, "done", ctx) };
  }
  // fallback
  if (item.store === "engram") {
    if (mirrors(type)) {
      return { kind: "apply", transition: settle(item, "replayed", ctx, autoMemoryOps(item, ctx, item.engramId === null ? {} : { engramId: item.engramId })) };
    }
    const file = memoryFileName(type, item.save.topic_key);
    const unlist: FileOp = { kind: "write", path: `${ctx.autoMemoryDir}/MEMORY.md`, content: removeIndexLine(ctx.index, file) };
    // Only the item's own copy is removed. Gone already (a crash after the removal): only its line is left to drop.
    // Changed since, or not read: the folder is left as it is; Engram has the save either way.
    const before: readonly FileOp[] = ctx.copy === null
      ? [unlist]
      : ctx.copy !== undefined && isOwnFallbackCopy(ctx.copy, item)
        ? [{ kind: "remove", path: `${ctx.autoMemoryDir}/${file}` }, unlist]
        : [];
    return { kind: "apply", transition: settle(item, "replayed", ctx, before) };
  }
  if (engramUsable(ctx.backend)) return { kind: "engram-save", args: engramSaveArgs(item, project), replay: true };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// The mem_save answer
// ---------------------------------------------------------------------------

/** One entry of `candidates[]` in a `judgment_required` answer. Its text is not in the answer: fetch it with `mem_get_observation`. */
export interface EngramCandidate {
  readonly id: number;
  readonly syncId: string | null;
  readonly title: string;
  readonly type: string;
  readonly score: number | null;
  /** The id `mem_judge` takes for this candidate; never reuse the top-level one. */
  readonly judgmentId: string;
  readonly topicKey: string | null;
}

export type MemSaveOutcome =
  | { readonly ok: true; readonly engramId: string | null; readonly candidates: readonly EngramCandidate[] }
  | { readonly ok: false; readonly kind: "rejected" | "ambiguous-project" | "unreadable"; readonly error: string };

const ERROR_CHARS = 300;
/** The plain message Engram's mem_save answers with, before (and inside) the 2.x envelope. */
const OLD_SAVED = /^Memory saved: /;

function firstText(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  for (const block of result.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

function readCandidate(value: unknown): EngramCandidate | null {
  if (!isRecord(value)) return null;
  const { id, sync_id: syncId, title, type, score, judgment_id: judgmentId, topic_key: topicKey } = value;
  if (typeof id !== "number" || typeof title !== "string" || typeof type !== "string" || typeof judgmentId !== "string" || judgmentId === "") return null;
  return {
    id,
    syncId: typeof syncId === "string" ? syncId : null,
    title,
    type,
    score: typeof score === "number" ? score : null,
    judgmentId,
    topicKey: typeof topicKey === "string" ? topicKey : null,
  };
}

/**
 * Engram's `mem_save` answer: a JSON envelope in the first text block
 * (`id`, `judgment_required`, `candidates[]`; read from Engram's own source).
 * A tool error, or text that is not that envelope, is a failure: a save is
 * counted only when Engram said it saved.
 */
export function parseMemSaveResult(result: unknown): MemSaveOutcome {
  const text = firstText(result);
  if (text === null) return { ok: false, kind: "unreadable", error: "mem_save returned no text" };
  if (isRecord(result) && result.isError === true) {
    return { ok: false, kind: /ambiguous_project/.test(text) ? "ambiguous-project" : "rejected", error: text.slice(0, ERROR_CHARS) };
  }
  // An older Engram (1.12.0) answers its plain message, with no envelope: saved, with no id and no candidates.
  if (OLD_SAVED.test(text)) return { ok: true, engramId: null, candidates: [] };
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, kind: "unreadable", error: "mem_save did not answer with its JSON envelope" };
  }
  if (!isRecord(envelope)) return { ok: false, kind: "unreadable", error: "mem_save did not answer with its JSON envelope" };
  const id = typeof envelope.id === "number" || typeof envelope.id === "string" ? String(envelope.id) : null;
  const candidates = envelope.judgment_required === true && Array.isArray(envelope.candidates)
    ? envelope.candidates.flatMap((entry) => {
        const candidate = readCandidate(entry);
        return candidate === null ? [] : [candidate];
      })
    : [];
  return { ok: true, engramId: id, candidates };
}

/**
 * Records the outcome of an Engram call. Success moves a pending item to
 * `written` and marks a fallback item as acknowledged (its next step settles
 * it). A failure keeps the item where it is, counts the attempt and keeps
 * the reason; a pending item's next step is then the fallback copy.
 */
export function completeEngramSave(item: SpoolItem, outcome: MemSaveOutcome, ctx: SpoolContext): Transition {
  if (outcome.ok) {
    const saved = { store: "engram" as const, engramId: outcome.engramId, candidates: outcome.candidates, engramFailed: false, lastFailure: null };
    return persist(withState(item, item.state === "pending" ? { ...saved, state: "written" } : saved, ctx), ctx);
  }
  const failure: SpoolFailure = { kind: isPermissionRefusal(outcome.error) ? "permission" : "failed", message: outcome.error };
  return persist(withState(item, { engramFailed: true, attempts: item.attempts + 1, lastFailure: failure }, ctx), ctx);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** An item of another session that has not moved for this long is taken over: its session crashed or ended. */
export const REPLAY_STALE_MS = 600_000;

export interface ReplayOptions {
  readonly currentSessionId: string;
  readonly now: string;
  readonly staleMs?: number;
}

export interface ReplayPlan {
  /** Oldest first. Settled items still in the live folder are here too, for their move. */
  readonly run: readonly SpoolItem[];
  /** Older items of a topic that a newer item replaces: close them with supersedeItem. */
  readonly superseded: readonly { readonly item: SpoolItem; readonly by: SpoolItem }[];
}

function byAge(a: SpoolItem, b: SpoolItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Which spooled items this session works through, and in what order. Its own
 * items and every settled one, every other session's fallback item (parked,
 * waiting only for Engram), and another session's pending or written item only
 * once it has been still for REPLAY_STALE_MS, so a session that is running is
 * never raced. Of several items on one topic only the newest is replayed: its
 * upsert makes Engram and the mirror end where replaying all of them in order
 * would, with one call instead of many.
 */
export function planReplay(items: readonly SpoolItem[], options: ReplayOptions): ReplayPlan {
  const staleMs = options.staleMs ?? REPLAY_STALE_MS;
  const nowMs = Date.parse(options.now);
  const stale = (item: SpoolItem): boolean => {
    const age = nowMs - Date.parse(item.updatedAt);
    return Number.isNaN(age) || age >= staleMs;
  };
  const eligible = [...items]
    .filter((item) => isSettled(item.state) || item.sessionId === options.currentSessionId || item.state === "fallback" || stale(item))
    .sort(byAge);
  const open = eligible.filter((item) => !isSettled(item.state));
  const newest = new Map<string, SpoolItem>();
  for (const item of open) newest.set(item.save.topic_key, item);
  const superseded: { item: SpoolItem; by: SpoolItem }[] = [];
  const dropped = new Set<SpoolItem>();
  for (const item of open) {
    const winner = newest.get(item.save.topic_key);
    if (winner !== undefined && winner !== item) {
      superseded.push({ item, by: winner });
      dropped.add(item);
    }
  }
  return { run: eligible.filter((item) => !dropped.has(item)), superseded };
}

/** Closes an item a newer save of its topic replaced. It touches no memory file: the newer item writes the same file. */
export function supersedeItem(item: SpoolItem, by: SpoolItem, ctx: SpoolContext): Transition {
  return settle(item, "done", ctx, [], { supersededBy: by.id });
}
