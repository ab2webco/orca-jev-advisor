// Typed façade over the plugin storage keys this plugin owns: `catalog`,
// `policies`, `board`, `log`, `config`. Every getter validates the raw
// value with a hand-written guard and returns either the validated,
// typed value or a documented default -- a corrupt or missing value NEVER
// throws into the worker. This matters because plugin workers are lazy
// (they fork per command/event, reap after 5 minutes idle, and die after
// 64 unacked events): all durable state lives here, in storage, never in
// worker memory, so a crashed/restarted worker must always be able to
// read back a sane value.
//
// This module takes the host's `storage` capability as an explicit
// parameter (`StorageHost`) rather than importing a global -- that keeps
// it usable both from the real plugin worker (main.mjs, wired to
// `host.storage`) and from a CLI/test harness with a fake in-memory host.

import { isArrayOf, isNumber, isRecord, isString, isStringOrNull } from "../guards.ts";
import { migratePolicyKind } from "./decisions.ts";
import type { PolicyKind, PolicyScope } from "./decisions.ts";

/** The subset of the host's `storage` capability this module needs. */
export interface StorageHost {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const STORAGE_KEY = {
  catalog: "catalog",
  policies: "policies",
  board: "board",
  log: "log",
  config: "config",
} as const;

async function readKey<T>(host: StorageHost, key: string, guard: (value: unknown) => value is T, fallback: T): Promise<T> {
  let raw: unknown;
  try {
    raw = await host.get(key);
  } catch {
    return fallback;
  }
  if (raw === undefined || raw === null) return fallback;
  return guard(raw) ? raw : fallback;
}

// ---------------------------------------------------------------------------
// catalog: the cross-worktree destination list (same shape as the root
// project's catalog.json / src/catalog.ts, duplicated here as a storage
// record because the plugin never imports the CLI's file-based loader).
// ---------------------------------------------------------------------------

export type DestinationKind = "service" | "client-site" | "project" | "support";

function isDestinationKind(value: unknown): value is DestinationKind {
  return value === "service" || value === "client-site" || value === "project" || value === "support";
}

/**
 * `actThreshold`, `confirmThreshold` and `maxAutoDelicateness` used to live
 * here too. Removed in the AB-benchmark pass: they were seeded by the panel
 * (a bare literal next to the widget, `config.html`'s old
 * `{ actThreshold: 0.9, confirmThreshold: 0.6, maxAutoDelicateness: 2 }`),
 * validated for shape here, and read by no decision anywhere. The comment
 * that used to sit on `consequenceCeiling` below claimed they "belong to
 * decideDestination's unrelated delicateness-level family" -- traced and
 * found false: `decideDestination` (decisions.ts) takes `{ action, policies,
 * policyAnswers, riskAnswers }` and never receives a destination's
 * `AutonomyConfig` at all; its risk stage judges against the module-level
 * `REVERSIBLE_GATE`/`EXTERNAL_GATE`/`CONSEQUENCE_CEILING` constants, the
 * same for every destination. `src/core/catalog.ts`, the other module that
 * declared these three fields, is itself imported by nothing in `src/` or
 * `adapters/` -- dead code, not merely dead fields. Removed rather than
 * defaulted, matching production-honesty-pass P2's precedent for the same
 * class of defect.
 */
export interface AutonomyConfig {
  /**
   * Per-destination override for decisions.ts's GATE_CONSEQUENCE_CEILING.
   * Optional -- absent means the gate falls back to GATE_CONSEQUENCE_CEILING
   * itself (decisions.ts's decideAction: `options?.consequenceCeiling ??
   * GATE_CONSEQUENCE_CEILING`). There used to be an editable "global"
   * consequenceCeiling on PluginConfig.thresholds below that this comment
   * pointed to -- removed in production-honesty-pass P2 once it turned out
   * getConfig() never fed it back into a decision either; this is the only
   * consequenceCeiling actually read anywhere, and (since the removal
   * above) the only field AutonomyConfig has left.
   */
  readonly consequenceCeiling?: number;
}

function isAutonomyConfig(value: unknown): value is AutonomyConfig {
  if (!isRecord(value)) return false;
  if ("consequenceCeiling" in value && value.consequenceCeiling !== undefined && !isNumber(value.consequenceCeiling)) {
    return false;
  }
  return true;
}

export interface CatalogDestination {
  readonly id: string;
  readonly label: string;
  readonly kind: DestinationKind;
  readonly worktreePath: string;
  readonly terminalTitleMatch?: string;
  readonly autonomy: AutonomyConfig;
}

function isCatalogDestination(value: unknown): value is CatalogDestination {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.label) || !isDestinationKind(value.kind) || !isString(value.worktreePath)) return false;
  if ("terminalTitleMatch" in value && value.terminalTitleMatch !== undefined && !isString(value.terminalTitleMatch)) return false;
  return isAutonomyConfig(value.autonomy);
}

export interface CatalogData {
  readonly destinations: readonly CatalogDestination[];
}

function isCatalogData(value: unknown): value is CatalogData {
  return isRecord(value) && isArrayOf(value.destinations, isCatalogDestination);
}

const DEFAULT_CATALOG: CatalogData = { destinations: [] };

export async function getCatalog(host: StorageHost): Promise<CatalogData> {
  return readKey(host, STORAGE_KEY.catalog, isCatalogData, DEFAULT_CATALOG);
}

export async function setCatalog(host: StorageHost, data: CatalogData): Promise<void> {
  await host.set(STORAGE_KEY.catalog, data);
}

// ---------------------------------------------------------------------------
// policies: the team's standing decisions, consumed by decideDestination.
// ---------------------------------------------------------------------------

// `kind` is the SAME PolicyKind union decisions.ts exports (imported above),
// never a parallel string union -- see interpretDestinationPolicy in
// decisions.ts, which switches on it exhaustively and would fail to compile
// if this file's `kind` could ever hold a value decisions.ts doesn't know.
export interface PolicyRow {
  readonly id: string;
  readonly rule: string;
  readonly kind: PolicyKind;
  /**
   * Optional per-destination scope. Absent or empty means "global": today's
   * behavior for all existing seeded rows, unchanged. See
   * filterPoliciesForDestination in decisions.ts for how this is
   * interpreted -- this module only validates the raw shape.
   */
  readonly destinations?: readonly string[];
  /**
   * Optional command/process/local-rule scope -- see decisions.ts's
   * PolicyScope for what the three values mean. Absent means "resolve it"
   * (resolvePolicyScope in decisions.ts): the shipped seed's own scope for
   * this same id, or `"command"` when the seed doesn't know this id either.
   * This module only validates the raw shape.
   */
  readonly scope?: PolicyScope;
}

/** The runtime list of PolicyKind's members, same technique policies.ts already uses for its own isPolicyKind. */
const POLICY_KINDS: readonly PolicyKind[] = ["permits", "requires_human", "prohibits"];

function isPolicyKind(value: unknown): value is PolicyKind {
  // Accepts the pre-rename Spanish spellings too: a row saved before the
  // rename is valid data that simply needs mapping, not a row to discard.
  // Dropping it silently emptied the policy stage on existing installs.
  return migratePolicyKind(value) !== null;
}

/** The runtime list of PolicyScope's members, same technique as isPolicyKind above. */
const POLICY_SCOPES: readonly PolicyScope[] = ["command", "process", "local-rule"];

function isPolicyScope(value: unknown): value is PolicyScope {
  return (POLICY_SCOPES as readonly unknown[]).includes(value);
}

/**
 * Exported so the seed reader validates rows against this exact shape rather
 * than a second, drifting copy of it.
 *
 * Deliberately silent on `scope`'s VALUE (only its presence matters here) --
 * see withNormalizedScope below for why. Before T10 (odd/tasks/release-
 * 0.5.1.md, JEVADV-28, R4) this rejected the whole row on an unrecognised
 * `scope`, which is MORE permissive on what is probably just a typo or a
 * value this build predates: a policy that should still cover its rule
 * silently vanished instead of resolving to its seed's scope, or `command`.
 */
export function isPolicyRow(value: unknown): value is PolicyRow {
  if (!isRecord(value) || !isString(value.id) || !isString(value.rule) || !isPolicyKind(value.kind)) return false;
  if ("destinations" in value && value.destinations !== undefined && !isArrayOf(value.destinations, isString)) return false;
  return true;
}

/**
 * A row already known to satisfy isPolicyRow, with an unrecognised `scope`
 * resolved to ABSENT instead of costing the whole row -- see isPolicyRow's
 * own comment. Absent is what resolvePolicyScope (decisions.ts) already
 * knows how to fall back from: the shipped seed's own scope for this id, or
 * `"command"`. `isPolicyRow`'s type predicate already declares `scope` as
 * `PolicyScope | undefined`; this is the one place that actually makes that
 * true, the same way `kind`'s Spanish/English resolution is deferred to
 * migratePolicyKind rather than settled at the shape check above.
 */
function withNormalizedScope(row: PolicyRow): PolicyRow {
  if (row.scope === undefined || isPolicyScope(row.scope)) return row;
  const { id, rule, kind, destinations } = row;
  return destinations !== undefined ? { id, rule, kind, destinations } : { id, rule, kind };
}

const DEFAULT_POLICIES: readonly PolicyRow[] = [];

/**
 * Reads the stored policies, keeping only the rows that are fully valid.
 *
 * Deliberately NOT `readKey(host, STORAGE_KEY.policies, isPoliciesData, ...)`
 * -- isPoliciesData (via isArrayOf's `.every`) is all-or-nothing: if even one
 * stored row lacked `kind` (every row did, before `kind` existed) or had an
 * invalid one, the WHOLE array would fail the guard and this would silently
 * fall back to the empty DEFAULT_POLICIES, disabling every policy the user
 * had ever written with no error and no trace.
 *
 * Instead this filters row by row. A row missing `kind` (or holding an
 * invalid one) is excluded from what the Jev judgment stage sees -- it is
 * never guessed into permits/requires_human/prohibits, so it behaves exactly
 * like "no policy covers this action" and falls through to the risk-based
 * fallback, which is the safe default either way. It is NOT deleted: this
 * function only decides what the WORKER judges with. The raw stored array is
 * untouched, and the config panel reads storage directly (not through this
 * function), so an incomplete row keeps showing up there, with its id and
 * rule intact, until a human picks its kind and saves again.
 */
export async function getPolicies(host: StorageHost): Promise<readonly PolicyRow[]> {
  let raw: unknown;
  try {
    raw = await host.get(STORAGE_KEY.policies);
  } catch {
    return [...DEFAULT_POLICIES];
  }
  if (raw === undefined || raw === null || !Array.isArray(raw)) return [...DEFAULT_POLICIES];
  return raw.filter(isPolicyRow).map(withNormalizedScope);
}

export async function setPolicies(host: StorageHost, policies: readonly PolicyRow[]): Promise<void> {
  await host.set(STORAGE_KEY.policies, policies);
}

// ---------------------------------------------------------------------------
// board: the cross-worktree status table. Populated by main.mjs's handler
// for the global `agent.status.changed` event -- storage is the only
// channel this plugin has for cross-worktree awareness that doesn't
// require spawning the `orca` CLI, since `agent.status.changed` carries a
// `worktreeId` regardless of which worktree's worker instance received it.
// ---------------------------------------------------------------------------

export interface BoardEntry {
  readonly worktreeId: string | null;
  /** Resolved from `orca worktree list --json` (best-effort; null when no match was found). */
  readonly project: string | null;
  /** Resolved the same way -- the worktree's display branch, not the raw `refs/heads/...` ref. */
  readonly rama: string | null;
  readonly paneKey: string;
  readonly state: string;
  /** Raw event timestamp, as delivered by `agent.status.changed`. */
  readonly receivedAt: number;
  /** When this plugin wrote the entry -- ISO 8601. */
  readonly updatedAt: string;
}

function isBoardEntry(value: unknown): value is BoardEntry {
  if (!isRecord(value)) return false;
  return (
    isStringOrNull(value.worktreeId) &&
    isStringOrNull(value.project) &&
    isStringOrNull(value.rama) &&
    isString(value.paneKey) &&
    isString(value.state) &&
    isNumber(value.receivedAt) &&
    isString(value.updatedAt)
  );
}

export interface BoardData {
  readonly entries: readonly BoardEntry[];
}

function isBoardData(value: unknown): value is BoardData {
  return isRecord(value) && isArrayOf(value.entries, isBoardEntry);
}

const DEFAULT_BOARD: BoardData = { entries: [] };

export async function getBoard(host: StorageHost): Promise<BoardData> {
  return readKey(host, STORAGE_KEY.board, isBoardData, DEFAULT_BOARD);
}

export async function setBoard(host: StorageHost, data: BoardData): Promise<void> {
  await host.set(STORAGE_KEY.board, data);
}

// ---------------------------------------------------------------------------
// log: the raw storage shape for the append-only decision log. The richer
// domain type (with a typed `rawAnswers`) lives in log.ts, which owns the
// append/trim/override behavior on top of this raw, validated shape.
// ---------------------------------------------------------------------------

export interface LogEntryRaw {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly judged: string;
  readonly rawAnswers: Record<string, unknown>;
  readonly verdict: string;
  readonly overriddenAt: string | null;
  readonly overriddenBy: string | null;
  readonly overrideNote: string | null;
}

function isLogEntryRaw(value: unknown): value is LogEntryRaw {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.at) &&
    isString(value.kind) &&
    isString(value.judged) &&
    isRecord(value.rawAnswers) &&
    isString(value.verdict) &&
    isStringOrNull(value.overriddenAt) &&
    isStringOrNull(value.overriddenBy) &&
    isStringOrNull(value.overrideNote)
  );
}

function isLogData(value: unknown): value is LogEntryRaw[] {
  return isArrayOf(value, isLogEntryRaw);
}

const DEFAULT_LOG: readonly LogEntryRaw[] = [];

export async function getLog(host: StorageHost): Promise<readonly LogEntryRaw[]> {
  return readKey(host, STORAGE_KEY.log, isLogData, [...DEFAULT_LOG]);
}

export async function setLog(host: StorageHost, entries: readonly LogEntryRaw[]): Promise<void> {
  await host.set(STORAGE_KEY.log, entries);
}

// ---------------------------------------------------------------------------
// config: plugin-wide settings edited from the config panel.
// ---------------------------------------------------------------------------

// actThreshold, confirmThreshold, reversibleGate, externalGate AND
// consequenceCeiling used to live here too, as a nested `thresholds` object
// -- declared, validated, defaulted and editable from the config panel, and
// read by no decision anywhere. Verified twice: first this file's own grep
// of src/ and adapters/ (excluding tests/panels/i18n; see
// odd/tasks/production-honesty-pass.md P2) found the first four dead; the
// coordinator then verified independently that getConfig() has exactly two
// callers -- log.ts (logMaxEntries) and main.mjs's cmdDecide (jevBudgetMs) --
// so consequenceCeiling was dead the same way. All five removed rather than
// wired: nobody could say what they were supposed to do, and inventing a
// meaning for a number is how this project got a wrong ceiling twice
// already. `thresholds` is gone as a wrapper too, not left empty -- an empty
// object achieving nothing is a smaller version of the same defect.
//
// The consequenceCeiling NUMBER is still useful (it's the ceiling the gate
// actually applies, and a destination can override it in its own row), so
// the panel still shows it -- read-only now, sourced from main.mjs's
// GATE_DEFAULTS_KEY mirror of decisions.ts's GATE_CONSEQUENCE_CEILING. It is
// simply no longer part of this plugin's editable, stored config, and this
// file no longer imports GATE_CONSEQUENCE_CEILING (nothing here uses it).
//
// A config saved before this removal still carries a `thresholds` object
// with all five old keys in storage -- isPluginConfig below no longer looks
// at `thresholds` at all, so it is ignored rather than failing validation;
// an old config is not a corrupt one.
export interface PluginConfig {
  readonly logMaxEntries: number;
  readonly jevBudgetMs: number;
}

function isPluginConfig(value: unknown): value is PluginConfig {
  return isRecord(value) && isNumber(value.logMaxEntries) && isNumber(value.jevBudgetMs);
}

const DEFAULT_CONFIG: PluginConfig = {
  logMaxEntries: 500,
  jevBudgetMs: 4_000,
};

export async function getConfig(host: StorageHost): Promise<PluginConfig> {
  return readKey(host, STORAGE_KEY.config, isPluginConfig, DEFAULT_CONFIG);
}

export async function setConfig(host: StorageHost, config: PluginConfig): Promise<void> {
  await host.set(STORAGE_KEY.config, config);
}
