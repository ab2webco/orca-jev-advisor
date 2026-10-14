// ---------------------------------------------------------------------------
// The board's time windows (odd/tasks/board-global-window.md, W1).
//
// One definition of "24 h", "7 days", "this version" and "all time" for every
// reader that feeds the Advisor board, so a card on one tab and a card on
// another speak for the same span. Pure: `nowMs` is always a parameter.
//
// `version` starts at the first gate decision stamped with the build that
// wrote the most recent stamped decision -- the same fold the gate's own
// "this version" view reads (gate_decision_totals.ts) -- so every tab's
// "this version" starts at the same instant.
//
// Retention: a source that prunes its logs cannot speak for a window older
// than what it keeps. `coverageSinceMs` is the earliest instant a summary
// can honestly speak for; the board names it when it is later than the
// window asked for, so a chip never silently does nothing on a card.
// ---------------------------------------------------------------------------

export type BoardWindowKey = "day" | "week" | "version" | "all";

/** The order the board's chips are shown in. */
export const BOARD_WINDOW_KEYS: readonly BoardWindowKey[] = ["day", "week", "version", "all"];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long the hourly usage, router, steward and typing logs are kept before read-consumption.mjs deletes them. */
export const HOURLY_LOG_KEPT_MS = 8 * DAY_MS;

export interface BoardWindow {
  readonly key: BoardWindowKey;
  /** The window's start; null for "all" (no bound) and for an unavailable "version". */
  readonly sinceMs: number | null;
  /** False only for "version" when no decision carries a build yet. */
  readonly available: boolean;
  /** The running build, for "version"; null otherwise. */
  readonly pluginVersion: string | null;
}

export type BoardWindows = { readonly [K in BoardWindowKey]: BoardWindow };

/** The build of the most recent stamped gate decision and the first time that build stamped one. */
export interface VersionStart {
  readonly pluginVersion: string;
  readonly firstAtMs: number | null;
}

/** The four windows at `nowMs`. */
export function boardWindows(nowMs: number, version: VersionStart | null): BoardWindows {
  const versionAvailable = version !== null && version.firstAtMs !== null;
  return {
    day: { key: "day", sinceMs: nowMs - DAY_MS, available: true, pluginVersion: null },
    week: { key: "week", sinceMs: nowMs - 7 * DAY_MS, available: true, pluginVersion: null },
    version: {
      key: "version",
      sinceMs: versionAvailable ? version.firstAtMs : null,
      available: versionAvailable,
      pluginVersion: versionAvailable ? version.pluginVersion : null,
    },
    all: { key: "all", sinceMs: null, available: true, pluginVersion: null },
  };
}

/**
 * The part of the gate log fold (gate_decision_totals.ts GateDecisionTotals)
 * "this version" reads. Structural, not imported: this module is in the
 * skills mod's import closure (through consumption.ts), which must stay free
 * of the gate's node:-importing modules.
 */
export interface VersionFold {
  readonly latestStamped: { readonly pluginVersion: string } | null;
  readonly byVersion: readonly (readonly [string, { readonly firstAtMs: number | null }])[];
}

/** The running build and its first stamped decision, from the gate log fold; null when no decision carries a build. */
export function versionStartOf(totals: VersionFold): VersionStart | null {
  if (totals.latestStamped === null) return null;
  const pluginVersion = totals.latestStamped.pluginVersion;
  const entry = totals.byVersion.find(([name]) => name === pluginVersion);
  return { pluginVersion, firstAtMs: entry === undefined ? null : entry[1].firstAtMs };
}

/**
 * The span before `nowMs` the window covers, in the `windowMs` shape the
 * existing summarizers take (`at >= nowMs - windowMs`). "all" is unbounded;
 * an unavailable window spans nothing.
 */
export function windowSpanMs(window: BoardWindow, nowMs: number): number {
  if (!window.available) return 0;
  if (window.sinceMs === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - window.sinceMs);
}

/** Whether an instant falls inside the window: from its start up to `nowMs`, both inclusive. */
export function isInWindow(atMs: number, window: BoardWindow, nowMs: number): boolean {
  if (!window.available || atMs > nowMs) return false;
  return window.sinceMs === null || atMs >= window.sinceMs;
}

/**
 * The earliest instant a summary of this window can honestly speak for:
 * the later of the window's start and `keptSinceMs`, the earliest instant
 * the source still keeps (null: the source keeps everything it ever wrote).
 * Null means "since the source began".
 */
export function coverageSinceMs(window: BoardWindow, keptSinceMs: number | null): number | null {
  if (keptSinceMs === null) return window.sinceMs;
  if (window.sinceMs === null) return keptSinceMs;
  return Math.max(window.sinceMs, keptSinceMs);
}
