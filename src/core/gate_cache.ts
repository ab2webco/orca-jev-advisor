// Pure validation and expiry for adapters/claude/gate-bash.ts's
// per-command-shape verdict cache (see CACHE_PATH in that file).
//
// Extracted for the same reason gate_safe_command.ts is: gate-bash.ts ends
// in a top-level `await main()`, so importing anything from it runs the
// whole hook. A pure module lets a test exercise the expiry/validation rule
// with no filesystem, no process, no stdin.
//
// The defect this closes: every cache entry already carried `at:
// Date.now()`, but nothing ever read it back, so a verdict cached months
// ago was reused forever -- even after Jev's judgment, the repo's
// catalog/policy mirror, or the surrounding context it reasons about had
// changed since. Fail-open stays intact: an unreadable or malformed cache
// (or an individual malformed entry) is never a crash, just a smaller
// cache -- see isValidGateCacheEntry.

/**
 * `"advise"` (the advise-model release): a risk-path advise can be cached --
 * never as a silent "allow" -- so the next identical command SHAPE advises
 * again without a fresh Jev call. Its `reason` (GateCacheEntry.reason) is
 * NOT the full model-facing advice text: it is the core, English, axis-level
 * rationale only (never locale-resolved, never containing recoverability
 * naming or the retry clause) -- see gate-bash.ts's own cache write/read for
 * the advise decision, which rebuilds the full text fresh on every hit
 * (recoverability depends on the CURRENT git status, which the shape-only
 * cache key knows nothing about).
 */
export type GateCacheDecision = "allow" | "deny" | "ask" | "advise";

export interface GateCacheEntry {
  readonly decision: GateCacheDecision;
  readonly reason: string;
  readonly at: number;
}

/**
 * How long a cached verdict stays valid before a fresh Jev call is required
 * again: 30 days.
 *
 * The cache key already folds in the command shape, the repo context and
 * the matched destination (see cacheKey in gate-bash.ts), so what goes
 * stale isn't "the same question asked again" -- it's everything the
 * verdict depended on that ISN'T part of the key: the model's own judgment
 * quality, and the catalog/policy mirror at the time of the call, both of
 * which can change without changing the key. A quarter is too long to
 * trust blindly against either drifting; a day would throw away nearly all
 * of the cache's value for a repo developers return to across a sprint.
 * One month is the each-way compromise: long enough that daily driving a
 * repo still hits the cache, short enough that a stale verdict cannot
 * outlive more than one release cycle of policy or model changes.
 */
export const GATE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const VALID_DECISIONS: ReadonlySet<string> = new Set(["allow", "deny", "ask", "advise"]);

/** True only for a well-shaped entry: this is what stands between a corrupt or hand-edited cache file and a crash. */
export function isValidGateCacheEntry(value: unknown): value is GateCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.decision === "string" &&
    VALID_DECISIONS.has(record.decision) &&
    typeof record.reason === "string" &&
    typeof record.at === "number" &&
    Number.isFinite(record.at)
  );
}

/** Strictly less-than: an entry exactly at the TTL boundary is already stale, never fresh. */
export function isFreshGateCacheEntry(entry: GateCacheEntry, now: number): boolean {
  return now - entry.at < GATE_CACHE_TTL_MS;
}

export interface PrunedGateCache {
  readonly fresh: Readonly<Record<string, GateCacheEntry>>;
  /** True when at least one entry was dropped -- expired, or shaped wrong -- so the caller knows whether the pruned result is worth persisting. */
  readonly changed: boolean;
}

/**
 * Keeps only valid, non-expired entries from a raw parsed cache object.
 * Never throws: a malformed entry (wrong shape, non-numeric `at`, an
 * unrecognized `decision`) is silently dropped, same fail-open discipline
 * as an unreadable file -- a corrupt cache is never a reason to block
 * anything, it is just a smaller cache.
 */
export function pruneGateCache(raw: Record<string, unknown>, now: number = Date.now()): PrunedGateCache {
  const fresh: Record<string, GateCacheEntry> = {};
  let changed = false;
  for (const [key, value] of Object.entries(raw)) {
    if (isValidGateCacheEntry(value) && isFreshGateCacheEntry(value, now)) {
      fresh[key] = value;
    } else {
      changed = true;
    }
  }
  return { fresh, changed };
}
