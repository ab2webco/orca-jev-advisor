// Pure validation, loading and pruning for adapters/claude/gate-bash.ts's
// per-command-shape verdict cache (see CACHE_PATH in that file).
//
// Extracted for the same reason gate_safe_command.ts is: gate-bash.ts ends
// in a top-level `await main()`, so importing anything from it runs the
// whole hook. A pure module lets a test exercise loading/expiry/validation
// with no filesystem, no process, no stdin, and no wall clock of its own --
// see the ADR-12 purity note below.
//
// The defect v1 had: the cache file was an unversioned flat map
// `{key: {decision, reason, at}}`. A schema change (adding a field, a new
// required invariant) looked EXACTLY like file corruption to a per-entry
// validator: every entry failed one at a time, and nothing distinguished
// "this install just upgraded" from "this file is garbage". v2 makes a
// schema mismatch a single, observable, whole-file RESET instead -- see
// GateCacheResetReason and loadGateCacheText below. Fail-open stays intact
// either way: absent, reset or partially-malformed all degrade to a smaller
// (possibly empty) cache, never a crash and never a blocked command.

/**
 * The cache's own file name, so every reader/writer of it agrees on one
 * constant rather than a repeated literal.
 */
export const GATE_CACHE_FILENAME = "gate-bash.json";

/** Bumped whenever the entry shape changes in a way old entries cannot satisfy -- see loadGateCacheText's version-mismatch reset. */
export const GATE_CACHE_SCHEMA_VERSION = 2;

/**
 * How long a cached verdict -- Jev's, a policy's, or a human's own approval
 * -- stays valid before a fresh judgment is required again: 30 days.
 *
 * The cache key already folds in the command shape, the repo context, the
 * matched destination and (from B2 on) the active policy set, so what goes
 * stale isn't "the same question asked again" -- it's everything the
 * verdict depended on that ISN'T part of the key: the model's own judgment
 * quality at call time, or (for a learned allow) whether a month-old human
 * approval should still speak for today's version of the same shape. A
 * quarter is too long to trust blindly against either drifting; a day would
 * throw away nearly all of the cache's value for a repo developers return
 * to across a sprint. One month is the each-way compromise.
 */
export const GATE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** v2 never writes 'deny': a denied command is refused outright by the NEVER_SILENTLY tier, before any cache lookup, so nothing about a deny is ever cacheable. */
export type GateCacheDecision = "allow" | "ask";

/** Who produced the verdict this entry caches: Jev's own judgment, a team policy match, or one qualifying human approval (see ADR-8, applyApprovalOutcome in a later slice). */
export type GateCacheSource = "jev" | "policy" | "human-approval";

export interface GateCacheEntry {
  readonly decision: GateCacheDecision;
  readonly reason: string;
  /** Verdict time, ms epoch. */
  readonly at: number;
  /** `at + TTL` for a fresh verdict, or `learnedAt + TTL` for a learned allow. Always strictly after `at`. */
  readonly expiresAt: number;
  readonly source: GateCacheSource;
  /**
   * Whether one qualifying human approval of THIS entry (while it is still
   * an 'ask') is allowed to promote it into a learned allow. Explicit and
   * computed at decision time (decideGateAction, a later slice) -- never
   * inferred from `axes === null` or from `source` alone (ADR-7/D2).
   */
  readonly learnable: boolean;
  /** The consequence axis score behind the verdict; null when a policy settled it (the risk stage never ran). */
  readonly score: number | null;
  /** The consequence ScoreAnswer's own confidence; null when there is no score to be confident about. Never fabricated when the model's answer carried none (see decisions.ts's NoulAnswer, which has no confidence field at all). */
  readonly confidence: number | null;
  /** formatShapeForDisplay(...) output -- for the learned-allows panel only, never re-parsed to recover the original command. */
  readonly shape: string;
  readonly project: string | null;
  readonly destinationId: string | null;
  /** git toplevel for the worktree this verdict was judged in, or cwd when there is none. */
  readonly worktreePath: string;
  /** Non-null iff `source === "human-approval"`: when the one qualifying approval happened. */
  readonly learnedAt: number | null;
}

export interface GateCacheFile {
  readonly version: 2;
  readonly entries: Readonly<Record<string, GateCacheEntry>>;
}

export type GateCacheResetReason = "unversioned" | "version-mismatch" | "unparseable" | "not-an-object";

export type GateCacheLoad =
  | { readonly kind: "absent"; readonly entries: Readonly<Record<string, GateCacheEntry>> }
  | {
      readonly kind: "loaded";
      readonly entries: Readonly<Record<string, GateCacheEntry>>;
      /** How many entries failed shape/invariant validation and were dropped -- distinct from a version reset: only THOSE entries are gone, everything else in the file survives. */
      readonly droppedMalformed: number;
      /** How many otherwise-valid entries were past their `expiresAt` and were dropped. */
      readonly droppedExpired: number;
    }
  | {
      readonly kind: "reset";
      readonly reason: GateCacheResetReason;
      /** The `version` field actually found on disk, when it parsed as a number; null for every other reset reason. */
      readonly foundVersion: number | null;
      readonly entries: Readonly<Record<string, GateCacheEntry>>;
    };

/**
 * True only for a well-shaped v2 entry, including the invariants that tie a
 * verdict's `source` to its `decision`/`learnable`/`learnedAt`: this is what
 * stands between a corrupt or hand-edited cache file and a crash, and
 * between a lower-priority verdict masquerading as a learned allow.
 */
export function isValidGateCacheEntry(value: unknown): value is GateCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;

  if (r.decision !== "allow" && r.decision !== "ask") return false;
  if (typeof r.reason !== "string") return false;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return false;
  if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) return false;
  if (r.expiresAt <= r.at) return false;
  if (r.source !== "jev" && r.source !== "policy" && r.source !== "human-approval") return false;
  if (typeof r.learnable !== "boolean") return false;
  if (r.score !== null && (typeof r.score !== "number" || !Number.isFinite(r.score))) return false;
  if (r.confidence !== null && (typeof r.confidence !== "number" || !Number.isFinite(r.confidence))) return false;
  if (typeof r.shape !== "string") return false;
  if (r.project !== null && typeof r.project !== "string") return false;
  if (r.destinationId !== null && typeof r.destinationId !== "string") return false;
  if (typeof r.worktreePath !== "string") return false;
  if (r.learnedAt !== null && (typeof r.learnedAt !== "number" || !Number.isFinite(r.learnedAt))) return false;

  if (r.source === "human-approval") {
    if (r.decision !== "allow") return false;
    if (r.learnedAt === null) return false;
    if (r.learnable !== true) return false;
  }
  if (r.source === "policy") {
    if (r.decision !== "ask") return false;
    if (r.learnable !== false) return false;
  }

  return true;
}

export interface PrunedGateCache {
  readonly fresh: Readonly<Record<string, GateCacheEntry>>;
  readonly droppedMalformed: number;
  readonly droppedExpired: number;
}

/**
 * Keeps only valid, non-expired entries from a raw parsed entries object.
 * Never throws: a malformed entry (wrong shape, a broken source/decision
 * invariant) is silently dropped, same fail-open discipline as an
 * unreadable file -- a corrupt cache is never a reason to block anything,
 * it is just a smaller cache. `now` has no default: every caller (the
 * adapter) must inject its own clock reading, so this module never reads
 * the wall clock itself (ADR-12) -- see the source-grep test in
 * gate_cache.test.ts.
 */
export function pruneGateCache(entries: Readonly<Record<string, unknown>>, now: number): PrunedGateCache {
  const fresh: Record<string, GateCacheEntry> = {};
  let droppedMalformed = 0;
  let droppedExpired = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (!isValidGateCacheEntry(value)) {
      droppedMalformed += 1;
      continue;
    }
    // Strictly not-before: an entry exactly at its expiry boundary is
    // already stale, never fresh -- same discipline v1 used.
    if (now >= value.expiresAt) {
      droppedExpired += 1;
      continue;
    }
    fresh[key] = value;
  }
  return { fresh, droppedMalformed, droppedExpired };
}

/**
 * Parses raw cache file text into one of three outcomes -- see GateCacheLoad
 * above. Never throws. `now` is injected, never read internally (ADR-12).
 */
export function loadGateCacheText(raw: string | null, now: number): GateCacheLoad {
  if (raw === null) return { kind: "absent", entries: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "reset", reason: "unparseable", foundVersion: null, entries: {} };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "reset", reason: "not-an-object", foundVersion: null, entries: {} };
  }

  const record = parsed as Record<string, unknown>;
  if (!("version" in record)) {
    // The legacy v1 shape: a flat map of entries with no file-level wrapper
    // at all. Every v1 entry looks like a malformed v2 one, but reporting
    // that as "many malformed entries" would hide that this is a schema
    // change, not corruption -- so the whole file resets as one unit.
    return { kind: "reset", reason: "unversioned", foundVersion: null, entries: {} };
  }

  const version = record.version;
  if (version !== GATE_CACHE_SCHEMA_VERSION) {
    return {
      kind: "reset",
      reason: "version-mismatch",
      foundVersion: typeof version === "number" ? version : null,
      entries: {},
    };
  }

  const rawEntries = record.entries;
  const entriesObject: Record<string, unknown> = typeof rawEntries === "object" && rawEntries !== null && !Array.isArray(rawEntries) ? (rawEntries as Record<string, unknown>) : {};
  const { fresh, droppedMalformed, droppedExpired } = pruneGateCache(entriesObject, now);
  return { kind: "loaded", entries: fresh, droppedMalformed, droppedExpired };
}

/** Serializes the current entry set into the v2 file shape `loadGateCacheText` reads back. */
export function serializeGateCacheFile(entries: Readonly<Record<string, GateCacheEntry>>): string {
  const file: GateCacheFile = { version: GATE_CACHE_SCHEMA_VERSION, entries };
  return JSON.stringify(file);
}

/**
 * Single-key read-modify-write (ADR-9): a human verdict outranks the model.
 * A fresh `source: "human-approval"` entry is never replaced by a lower-
 * priority (Jev or policy) verdict -- the caller must re-read immediately
 * before calling this, so the "existing" entry it sees is as current as
 * possible, bounding the lost-update window to this one call rather than a
 * whole Jev round trip.
 */
export function putVerdict(
  entries: Readonly<Record<string, GateCacheEntry>>,
  key: string,
  entry: GateCacheEntry,
  now: number,
): Readonly<Record<string, GateCacheEntry>> {
  const existing = entries[key];
  if (existing !== undefined && existing.source === "human-approval" && existing.expiresAt > now && entry.source !== "human-approval") {
    return entries;
  }
  return { ...entries, [key]: entry };
}
