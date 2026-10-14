// ---------------------------------------------------------------------------
// Memory module in Shadow (odd/tasks/memory-shadow.md, M8).
//
// In Shadow the module decides, drafts on a sample and builds the judge, and
// writes nothing. This file holds what it measures:
//   - the row it logs per decision (`memory-decisions-<hour>.jsonl`), which
//     carries counts, types, outcomes and token usage, never memory content;
//   - the fork sample, a fixed 1 in 5 (a constant, never a setting);
//   - what the main thread itself saved in the same turn (Engram's mem_save
//     and mem_judge, a Write or Edit into the auto-memory folder), seen by
//     the `tool.call` hook after `next`, for agreement against the gate;
//   - the dry judge: prompts built, nothing asked;
//   - the weekly summary the Modules card shows.
//
// Pure: no I/O and no node: import, so the mod sandbox can load it too.
// ---------------------------------------------------------------------------

import { isRecord } from "../guards.ts";
import { MEMORY_TYPES, routeSave } from "./memory_decide.ts";
import type { MemoryType } from "./memory_decide.ts";
import type { MemoryBackendDecision } from "./memory_detect.ts";
import type { DraftSave, MemoryDraft } from "./memory_draft.ts";
import { buildJudgePrompt } from "./memory_judge.ts";
import { engramTypeOf } from "./memory_spool.ts";
import { parseFrontmatter } from "./memory_tidy.ts";

// ---------------------------------------------------------------------------
// The log file
// ---------------------------------------------------------------------------

export const MEMORY_DECISIONS_FILE_PATTERN = /^memory-decisions-(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** `memory-decisions-YYYY-MM-DDTHH.jsonl` for the hour `atIso` falls in. */
export function memoryDecisionFileName(atIso: string): string {
  return `memory-decisions-${atIso.slice(0, 13)}.jsonl`;
}

// ---------------------------------------------------------------------------
// The fork sample
// ---------------------------------------------------------------------------

/**
 * In Shadow one UPDATE turn in this many is drafted. A fork re-reads the
 * whole session (a median 187k context, mods review 5.7), so the sample keeps
 * that quota cost bounded while still measuring what a draft holds. Fixed in
 * code and stated on the card; not a setting.
 */
export const FORK_SAMPLE_EVERY = 5;

/** FNV-1a, 32 bits: a stable spread of a short key. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Whether this turn is in the fork sample: deterministic per session and turn, about one in FORK_SAMPLE_EVERY. */
export function isForkSampled(sessionId: string | null, turnId: string): boolean {
  return fnv1a(`${sessionId ?? ""}:${turnId}`) % FORK_SAMPLE_EVERY === 0;
}

// ---------------------------------------------------------------------------
// What the main thread saved
// ---------------------------------------------------------------------------

export type MainMemoryCall = "engram-save" | "engram-judge" | "auto-memory-write";

const ENGRAM_TOOL = /^mcp__(?:engram|plugin_engram_engram)__(mem_save|mem_judge)$/;
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Which memory call a main-thread tool call is, or null. A Write or Edit counts only for a `.md` directly in the memory dir. */
export function classifyMainCall(tool: string, args: Readonly<Record<string, unknown>>, autoMemoryDir: string | null): MainMemoryCall | null {
  const engram = ENGRAM_TOOL.exec(tool);
  if (engram !== null) return engram[1] === "mem_save" ? "engram-save" : "engram-judge";
  if (!FILE_WRITE_TOOLS.has(tool) || autoMemoryDir === null) return null;
  const path = args.file_path;
  if (typeof path !== "string") return null;
  const dir = `${autoMemoryDir.replace(/\/+$/, "")}/`;
  if (!path.startsWith(dir)) return null;
  const name = path.slice(dir.length);
  return !name.includes("/") && name.endsWith(".md") ? "auto-memory-write" : null;
}

/** A candidate of a `judgment_required` answer: its title and type, kept in memory for the dry judge and never logged. */
export interface SeenCandidate {
  readonly title: string;
  readonly type: string;
}

export interface MainMemorySeen {
  readonly engramSaves: number;
  /** Saves by the Engram type the main thread gave (`manual` when it gave none, as Engram does). */
  readonly engramSaveTypes: Readonly<Record<string, number>>;
  readonly judges: number;
  readonly autoMemoryWrites: number;
  readonly candidates: readonly SeenCandidate[];
}

export const EMPTY_SEEN: MainMemorySeen = { engramSaves: 0, engramSaveTypes: {}, judges: 0, autoMemoryWrites: 0, candidates: [] };

export interface MainCallDetail {
  /** mem_save's `type` argument. */
  readonly type?: unknown;
  readonly candidates?: readonly SeenCandidate[];
}

/** The seen counts with one more call. Returns a new value. */
export function noteMainCall(seen: MainMemorySeen, call: MainMemoryCall, detail: MainCallDetail): MainMemorySeen {
  if (call === "engram-judge") return { ...seen, judges: seen.judges + 1 };
  if (call === "auto-memory-write") return { ...seen, autoMemoryWrites: seen.autoMemoryWrites + 1 };
  const type = typeof detail.type === "string" && detail.type.trim() !== "" ? detail.type.trim() : "manual";
  return {
    ...seen,
    engramSaves: seen.engramSaves + 1,
    engramSaveTypes: { ...seen.engramSaveTypes, [type]: (seen.engramSaveTypes[type] ?? 0) + 1 },
    candidates: [...seen.candidates, ...(detail.candidates ?? [])],
  };
}

function envelopeText(result: unknown): string | null {
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result) ? result : isRecord(result) && result.isError !== true && Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return null;
}

/**
 * The candidates of a main-thread `mem_save` answer (`judgment_required`), as
 * the tool result reaches `tool.call` after `next`: a string, the content
 * blocks, or the MCP `{ content, isError }`. Anything else is none.
 */
export function readMemSaveCandidates(result: unknown): readonly SeenCandidate[] {
  const text = envelopeText(result);
  if (text === null) return [];
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(envelope) || envelope.judgment_required !== true || !Array.isArray(envelope.candidates)) return [];
  return envelope.candidates.flatMap((entry) => (isRecord(entry) && typeof entry.title === "string" && typeof entry.type === "string" ? [{ title: entry.title, type: entry.type }] : []));
}

// ---------------------------------------------------------------------------
// Agreement, the draft and the dry judge
// ---------------------------------------------------------------------------

/** The gate's outcome: its two verdicts, an answer that is neither (malformed), or no answer at all. */
export type GateOutcome = "skip" | "update" | "malformed" | "no-answer";

export type Agreement = "both" | "module-only" | "main-only" | "neither" | "unknown";

/** The gate's verdict against whether the main thread saved anything (Engram or auto-memory) in the same turn. */
export function agreementOf(gate: GateOutcome, mainSaved: boolean): Agreement {
  if (gate === "update") return mainSaved ? "both" : "module-only";
  if (gate === "skip") return mainSaved ? "main-only" : "neither";
  return "unknown";
}

export interface DraftCounts {
  readonly wouldSave: Readonly<Record<MemoryType, number>>;
  readonly wouldUpdate: number;
  readonly wouldDelete: number;
  /** Saves that would go to Engram, now or on replay. */
  readonly toEngram: number;
  /** Saves that would also, or only, be an auto-memory file. */
  readonly toAutoMemory: number;
}

function zeroTypes(): Record<MemoryType, number> {
  return { user: 0, feedback: 0, project: 0, reference: 0 };
}

/** What a draft would have done on this backend, as counts. */
export function draftCounts(draft: MemoryDraft, backend: MemoryBackendDecision): DraftCounts {
  const wouldSave = zeroTypes();
  let toEngram = 0;
  let toAutoMemory = 0;
  for (const save of draft.saves) {
    wouldSave[save.type] += 1;
    const route = routeSave(save.type, backend);
    if (route.engram !== "never") toEngram += 1;
    if (route.autoMemory !== "none") toAutoMemory += 1;
  }
  return { wouldSave, wouldUpdate: draft.updates.length, wouldDelete: draft.deletes.length, toEngram, toAutoMemory };
}

/**
 * The dry judge: the judge prompt built for each drafted save against each
 * candidate the main thread's own mem_save surfaced this turn. In Shadow the
 * candidate's text cannot be fetched (only `mem_current_project` is called),
 * so its title stands for it. Nothing is asked: the count is what Active
 * would have sent to Haiku.
 */
export function dryJudgeBuilds(saves: readonly DraftSave[], candidates: readonly SeenCandidate[]): number {
  let builds = 0;
  for (const save of saves) {
    for (const candidate of candidates) {
      const prompt = buildJudgePrompt({ saved: { title: save.title, type: engramTypeOf(save.type), content: save.content }, candidate: { title: candidate.title, type: candidate.type, content: candidate.title } });
      if (prompt.length > 0) builds += 1;
    }
  }
  return builds;
}

/** The topic keys of the auto-memory files, sorted: what the fork reuses when Engram is the store. */
export function memoryTopics(files: Readonly<Record<string, string>>): string[] {
  const keys = new Set<string>();
  for (const text of Object.values(files)) {
    const key = parseFrontmatter(text).topicKey;
    if (key !== null) keys.add(key);
  }
  return [...keys].sort();
}

/** The memory files the fork reads, in name order: whole files only, at most `maxFiles` and `maxChars` in all; MEMORY.md is the index, not a memory. */
export function withinBudget(files: Readonly<Record<string, string>>, maxFiles: number, maxChars: number): Record<string, string> {
  const kept: Record<string, string> = {};
  let count = 0;
  let chars = 0;
  for (const name of Object.keys(files).sort()) {
    const text = files[name];
    if (text === undefined || name.toLowerCase() === "memory.md") continue;
    if (count >= maxFiles) break;
    if (chars + text.length > maxChars) continue;
    kept[name] = text;
    count += 1;
    chars += text.length;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** `$.model.complete`/`fork` usage, in the API's spelling. */
export interface ModelTokens {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

export interface RowTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** The fork's outcome on an UPDATE turn: not in the sample, sampled but a new turn had started, a parsed draft, an answer that is not one, or no answer. */
export type ForkOutcome = "not-sampled" | "turn-moved-on" | "drafted" | "unparsable" | "no-answer";

/** The module's switch, and what ran: Active runs as Shadow while Engram is live (memory_active.ts effectiveMemoryMode). */
export type MemoryMode = "shadow" | "active";

/** What Active wrote in one pass, as counts (odd/tasks/memory-active-files.md). Shadow writes nothing: NO_WRITES. */
export interface ActiveWriteCounts {
  /** Saves put in the spool before any memory file was touched. */
  readonly spooled: number;
  /** Memory files created. */
  readonly written: number;
  /** Existing memory files rewritten, each after its backup. */
  readonly updated: number;
  /** Files copied byte for byte to `.memory-backup/` before a rewrite. */
  readonly backups: number;
  /** Updates refused: the file was not there, or the new text had no frontmatter name. */
  readonly dropped: number;
  /** Writes that failed; a save among them stays spooled. */
  readonly writeFailures: number;
  /** Claude Code's own consolidation held the folder, so nothing was written. */
  readonly lockHeld: boolean;
  // Engram live (odd/tasks/memory-active-engram.md).
  /** Saves Engram took (`mem_save` answered a success). */
  readonly engramSaved: number;
  /** `mem_save` calls that failed, were refused or timed out; each left a fallback file. */
  readonly engramFailed: number;
  /** user and feedback saves mirrored into the auto-memory folder with their engram_id. */
  readonly mirrored: number;
  /** Conflict candidates whose verdict was recorded with `mem_judge`. */
  readonly judged: number;
  /** Candidates left pending in Engram for a person: low confidence, or a protected type. */
  readonly judgePending: number;
  /** Candidates not judged because this Engram lists no `mem_judge`. */
  readonly judgeUnavailable: number;
  /** Candidates not judged because their text, Haiku's answer or the `mem_judge` call failed; they stay pending in Engram. */
  readonly judgeFailed: number;
  /** The fork's saves dropped because the main thread saved to Engram in the same turn. */
  readonly droppedMainSaved: number;
  /** Haiku's tokens for the judge calls. */
  readonly judgeTokens: { readonly input: number; readonly output: number };
  /** Replay only: parked fallback items Engram took at a session start. */
  readonly replayedToEngram: number;
  /** Replay only: fallback copies (project, reference) removed once Engram had them. */
  readonly fallbackRemoved: number;
  /** Replay only: fallback copies (user, feedback) turned into mirrors. */
  readonly fallbackMirrored: number;
}

export const NO_WRITES: ActiveWriteCounts = {
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
  replayedToEngram: 0,
  fallbackRemoved: 0,
  fallbackMirrored: 0,
};

/** The Engram counts a decision row and a replay row both carry. */
export interface EngramRowCounts {
  readonly engramSaved: number;
  readonly engramFailed: number;
  readonly mirrored: number;
  readonly judged: number;
  readonly judgePending: number;
  readonly judgeUnavailable: number;
  readonly judgeFailed: number;
  readonly judgeTokens: { readonly input: number; readonly output: number };
}

function engramRowCounts(writes: ActiveWriteCounts): EngramRowCounts {
  return {
    engramSaved: writes.engramSaved,
    engramFailed: writes.engramFailed,
    mirrored: writes.mirrored,
    judged: writes.judged,
    judgePending: writes.judgePending,
    judgeUnavailable: writes.judgeUnavailable,
    judgeFailed: writes.judgeFailed,
    judgeTokens: { input: writes.judgeTokens.input, output: writes.judgeTokens.output },
  };
}

export interface MemoryShadowRecordInput {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly backend: MemoryBackendDecision;
  /** Where the backend was decided: at session start, or re-detected at this turn. */
  readonly detectedAt: "start" | "turn";
  readonly gate: GateOutcome;
  readonly gateMs: number | null;
  readonly gateUsage: ModelTokens | null;
  /** Null when the gate did not say UPDATE. */
  readonly fork: ForkOutcome | null;
  readonly forkMs: number | null;
  readonly forkUsage: ModelTokens | null;
  readonly draft: DraftCounts | null;
  readonly judgeBuilds: number;
  readonly seen: MainMemorySeen;
  /** The switch; Shadow when absent. */
  readonly mode?: MemoryMode;
  /** What ran; Shadow when absent. */
  readonly effective?: MemoryMode;
  /** What Active wrote; NO_WRITES when absent. */
  readonly writes?: ActiveWriteCounts;
}

export interface MemoryShadowRecord extends EngramRowCounts {
  readonly droppedMainSaved: number;
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly mode: MemoryMode;
  readonly effective: MemoryMode;
  readonly sessionId: string | null;
  readonly backend: MemoryBackendDecision["backend"];
  readonly decidedBy: MemoryBackendDecision["decidedBy"];
  readonly permission: MemoryBackendDecision["permission"];
  readonly detectedAt: "start" | "turn";
  readonly gate: GateOutcome;
  readonly gateMs: number | null;
  readonly gateTokens: RowTokens | null;
  readonly forkSampled: boolean;
  readonly fork: ForkOutcome | null;
  readonly forkMs: number | null;
  readonly forkTokens: RowTokens | null;
  readonly wouldSave: Readonly<Record<MemoryType, number>>;
  readonly wouldUpdate: number;
  readonly wouldDelete: number;
  readonly toEngram: number;
  readonly toAutoMemory: number;
  readonly judgeBuilds: number;
  readonly mainEngramSaves: number;
  readonly mainEngramSaveTypes: Readonly<Record<string, number>>;
  readonly mainJudges: number;
  readonly mainCandidates: number;
  readonly mainAutoMemoryWrites: number;
  readonly agreement: Agreement;
  readonly spooled: number;
  readonly written: number;
  readonly updated: number;
  readonly backups: number;
  readonly dropped: number;
  readonly writeFailures: number;
  readonly lockHeld: boolean;
}

function rowTokens(usage: ModelTokens | null): RowTokens | null {
  if (usage === null) return null;
  return { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens };
}

/** One log line: counts, types, outcomes and usage. No memory text, title or gate reason ever reaches it. */
export function memoryShadowRecord(input: MemoryShadowRecordInput): MemoryShadowRecord {
  const draft = input.draft;
  const seen = input.seen;
  const writes = input.writes ?? NO_WRITES;
  return {
    at: input.at,
    account: input.account,
    project: input.project,
    mode: input.mode ?? "shadow",
    effective: input.effective ?? "shadow",
    sessionId: input.sessionId,
    backend: input.backend.backend,
    decidedBy: input.backend.decidedBy,
    permission: input.backend.permission,
    detectedAt: input.detectedAt,
    gate: input.gate,
    gateMs: input.gateMs,
    gateTokens: rowTokens(input.gateUsage),
    forkSampled: input.fork !== null && input.fork !== "not-sampled",
    fork: input.fork,
    forkMs: input.forkMs,
    forkTokens: rowTokens(input.forkUsage),
    wouldSave: draft === null ? zeroTypes() : { ...draft.wouldSave },
    wouldUpdate: draft === null ? 0 : draft.wouldUpdate,
    wouldDelete: draft === null ? 0 : draft.wouldDelete,
    toEngram: draft === null ? 0 : draft.toEngram,
    toAutoMemory: draft === null ? 0 : draft.toAutoMemory,
    judgeBuilds: input.judgeBuilds,
    mainEngramSaves: seen.engramSaves,
    mainEngramSaveTypes: { ...seen.engramSaveTypes },
    mainJudges: seen.judges,
    mainCandidates: seen.candidates.length,
    mainAutoMemoryWrites: seen.autoMemoryWrites,
    agreement: agreementOf(input.gate, seen.engramSaves > 0 || seen.autoMemoryWrites > 0),
    spooled: writes.spooled,
    written: writes.written,
    updated: writes.updated,
    backups: writes.backups,
    dropped: writes.dropped,
    writeFailures: writes.writeFailures,
    lockHeld: writes.lockHeld,
    ...engramRowCounts(writes),
    droppedMainSaved: writes.droppedMainSaved,
  };
}

export interface MemoryReplayRecordInput {
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly backend: MemoryBackendDecision;
  /** Spool items this pass took up (planReplay's run and superseded). */
  readonly items: number;
  /** Items that reached done/, or were parked as a fallback copy, in this pass. */
  readonly replayed: number;
  /** Older items of a topic a newer one replaced, closed without a write. */
  readonly superseded: number;
  readonly writes: ActiveWriteCounts;
}

export interface MemoryReplayRecord extends EngramRowCounts {
  readonly replayedToEngram: number;
  readonly fallbackRemoved: number;
  readonly fallbackMirrored: number;
  readonly at: string;
  readonly account: string;
  readonly project: string;
  readonly event: "replay";
  readonly mode: "active";
  readonly effective: "active";
  readonly sessionId: string | null;
  readonly backend: MemoryBackendDecision["backend"];
  readonly decidedBy: MemoryBackendDecision["decidedBy"];
  readonly permission: MemoryBackendDecision["permission"];
  readonly items: number;
  readonly replayed: number;
  readonly superseded: number;
  readonly written: number;
  readonly updated: number;
  readonly backups: number;
  readonly writeFailures: number;
  readonly lockHeld: boolean;
}

/** The row a spool replay at session start logs when it found items: counts only, and never a decision. */
export function memoryReplayRecord(input: MemoryReplayRecordInput): MemoryReplayRecord {
  return {
    at: input.at,
    account: input.account,
    project: input.project,
    event: "replay",
    mode: "active",
    effective: "active",
    sessionId: input.sessionId,
    backend: input.backend.backend,
    decidedBy: input.backend.decidedBy,
    permission: input.backend.permission,
    items: input.items,
    replayed: input.replayed,
    superseded: input.superseded,
    written: input.writes.written,
    updated: input.writes.updated,
    backups: input.writes.backups,
    writeFailures: input.writes.writeFailures,
    lockHeld: input.writes.lockHeld,
    ...engramRowCounts(input.writes),
    replayedToEngram: input.writes.replayedToEngram,
    fallbackRemoved: input.writes.fallbackRemoved,
    fallbackMirrored: input.writes.fallbackMirrored,
  };
}

// ---------------------------------------------------------------------------
// The summary the card shows
// ---------------------------------------------------------------------------

export interface MemoryShadowSummary {
  readonly decisions: number;
  /** Haiku gate calls: every row asked once. */
  readonly gates: number;
  readonly updates: number;
  readonly skips: number;
  readonly gateFailures: number;
  /** UPDATE over the gates that gave a verdict; null with none. */
  readonly updateRate: number | null;
  /** Forks that ran (drafted, unparsable or no answer). */
  readonly forks: number;
  readonly drafts: number;
  readonly wouldSave: Readonly<Record<MemoryType, number>>;
  readonly judgeBuilds: number;
  readonly mainEngramSaves: number;
  readonly mainJudges: number;
  readonly mainAutoMemoryWrites: number;
  readonly agreement: { readonly both: number; readonly moduleOnly: number; readonly mainOnly: number; readonly neither: number; readonly unknown: number };
  /** Turns where the gate and the main thread agreed, over the turns with a verdict; null with none. */
  readonly agreementRate: number | null;
  readonly haikuTokens: { readonly input: number; readonly output: number };
  readonly forkTokens: { readonly input: number; readonly output: number; readonly cacheRead: number };
  /** The newest row's backend: what the module last detected. */
  readonly latest: { readonly at: string; readonly backend: string; readonly decidedBy: string; readonly permission: string } | null;
  /** Decisions that ran in Active (written to the files store), not those that only measured. */
  readonly activeDecisions: number;
  /** Forks that ran and gave no draft (unparsable or no answer): nothing was written. */
  readonly draftFailures: number;
  /** Active's writes, over decisions and replays alike. */
  readonly spooled: number;
  readonly written: number;
  readonly updated: number;
  readonly backups: number;
  readonly dropped: number;
  readonly writeFailures: number;
  /** Passes that found the folder locked. */
  readonly lockHeld: number;
  /** Replay rows (a session start that found spooled items), and the items they moved on. */
  readonly replays: number;
  readonly replayed: number;
  /** Engram live (odd/tasks/memory-active-engram.md), over decisions and replays alike. */
  readonly engramSaved: number;
  readonly engramFailed: number;
  readonly mirrored: number;
  readonly judged: number;
  readonly judgePending: number;
  readonly judgeUnavailable: number;
  readonly judgeFailed: number;
  readonly droppedMainSaved: number;
  readonly replayedToEngram: number;
  readonly fallbackRemoved: number;
  readonly fallbackMirrored: number;
}

const ENGRAM_COUNTS = ["engramSaved", "engramFailed", "mirrored", "judged", "judgePending", "judgeUnavailable", "judgeFailed", "droppedMainSaved", "replayedToEngram", "fallbackRemoved", "fallbackMirrored"] as const;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokensOf(value: unknown): { input: number; output: number; cacheRead: number } {
  if (!isRecord(value)) return { input: 0, output: 0, cacheRead: 0 };
  return { input: count(value.input), output: count(value.output), cacheRead: count(value.cacheRead) };
}

const RAN_FORKS: readonly unknown[] = ["drafted", "unparsable", "no-answer"];

/** What the module measured over the `windowMs` before `nowMs`. Rows are read tolerantly: anything malformed is skipped. */
export function summarizeMemoryDecisions(rows: readonly unknown[], nowMs: number, windowMs: number): MemoryShadowSummary {
  let decisions = 0;
  let updates = 0;
  let skips = 0;
  let forks = 0;
  let drafts = 0;
  let judgeBuilds = 0;
  let mainEngramSaves = 0;
  let mainJudges = 0;
  let mainAutoMemoryWrites = 0;
  const wouldSave = zeroTypes();
  const agreement = { both: 0, moduleOnly: 0, mainOnly: 0, neither: 0, unknown: 0 };
  const haikuTokens = { input: 0, output: 0 };
  const forkTokens = { input: 0, output: 0, cacheRead: 0 };
  let latest: MemoryShadowSummary["latest"] = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  const active = { activeDecisions: 0, draftFailures: 0, spooled: 0, written: 0, updated: 0, backups: 0, dropped: 0, writeFailures: 0, lockHeld: 0, replays: 0, replayed: 0 };
  const engram: Record<(typeof ENGRAM_COUNTS)[number], number> = { engramSaved: 0, engramFailed: 0, mirrored: 0, judged: 0, judgePending: 0, judgeUnavailable: 0, judgeFailed: 0, droppedMainSaved: 0, replayedToEngram: 0, fallbackRemoved: 0, fallbackMirrored: 0 };
  for (const row of rows) {
    if (!isRecord(row) || typeof row.at !== "string") continue;
    const atMs = Date.parse(row.at);
    if (Number.isNaN(atMs) || atMs > nowMs || atMs < nowMs - windowMs) continue;
    for (const key of ENGRAM_COUNTS) engram[key] += count(row[key]);
    // The judge's Haiku calls count against the same quota as the gate's.
    const judge = tokensOf(row.judgeTokens);
    haikuTokens.input += judge.input;
    haikuTokens.output += judge.output;
    active.spooled += count(row.spooled);
    active.written += count(row.written);
    active.updated += count(row.updated);
    active.backups += count(row.backups);
    active.dropped += count(row.dropped);
    active.writeFailures += count(row.writeFailures);
    if (row.lockHeld === true) active.lockHeld += 1;
    if (row.event === "replay") {
      active.replays += 1;
      active.replayed += count(row.replayed);
      continue;
    }
    decisions += 1;
    if (row.effective === "active") active.activeDecisions += 1;
    if (row.fork === "unparsable" || row.fork === "no-answer") active.draftFailures += 1;
    if (row.gate === "update") updates += 1;
    if (row.gate === "skip") skips += 1;
    if (RAN_FORKS.includes(row.fork)) forks += 1;
    if (row.fork === "drafted") drafts += 1;
    if (isRecord(row.wouldSave)) for (const type of MEMORY_TYPES) wouldSave[type] += count(row.wouldSave[type]);
    judgeBuilds += count(row.judgeBuilds);
    mainEngramSaves += count(row.mainEngramSaves);
    mainJudges += count(row.mainJudges);
    mainAutoMemoryWrites += count(row.mainAutoMemoryWrites);
    if (row.agreement === "both") agreement.both += 1;
    else if (row.agreement === "module-only") agreement.moduleOnly += 1;
    else if (row.agreement === "main-only") agreement.mainOnly += 1;
    else if (row.agreement === "neither") agreement.neither += 1;
    else agreement.unknown += 1;
    const gate = tokensOf(row.gateTokens);
    haikuTokens.input += gate.input;
    haikuTokens.output += gate.output;
    const fork = tokensOf(row.forkTokens);
    forkTokens.input += fork.input;
    forkTokens.output += fork.output;
    forkTokens.cacheRead += fork.cacheRead;
    if (atMs > latestMs && typeof row.backend === "string") {
      latestMs = atMs;
      latest = { at: row.at, backend: row.backend, decidedBy: typeof row.decidedBy === "string" ? row.decidedBy : "none", permission: typeof row.permission === "string" ? row.permission : "unknown" };
    }
  }
  const verdicts = updates + skips;
  const judged = agreement.both + agreement.moduleOnly + agreement.mainOnly + agreement.neither;
  return {
    decisions,
    gates: decisions,
    updates,
    skips,
    gateFailures: decisions - verdicts,
    updateRate: verdicts > 0 ? updates / verdicts : null,
    forks,
    drafts,
    wouldSave,
    judgeBuilds,
    mainEngramSaves,
    mainJudges,
    mainAutoMemoryWrites,
    agreement,
    agreementRate: judged > 0 ? (agreement.both + agreement.neither) / judged : null,
    haikuTokens,
    forkTokens,
    latest,
    ...active,
    ...engram,
  };
}
