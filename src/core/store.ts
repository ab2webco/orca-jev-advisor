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

export interface AutonomyConfig {
  readonly actThreshold: number;
  readonly confirmThreshold: number;
  readonly maxAutoDelicateness: number;
}

function isAutonomyConfig(value: unknown): value is AutonomyConfig {
  return isRecord(value) && isNumber(value.actThreshold) && isNumber(value.confirmThreshold) && isNumber(value.maxAutoDelicateness);
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

export interface PolicyRow {
  readonly id: string;
  readonly rule: string;
}

function isPolicyRow(value: unknown): value is PolicyRow {
  return isRecord(value) && isString(value.id) && isString(value.rule);
}

function isPoliciesData(value: unknown): value is PolicyRow[] {
  return isArrayOf(value, isPolicyRow);
}

const DEFAULT_POLICIES: readonly PolicyRow[] = [];

export async function getPolicies(host: StorageHost): Promise<readonly PolicyRow[]> {
  return readKey(host, STORAGE_KEY.policies, isPoliciesData, [...DEFAULT_POLICIES]);
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

export interface PluginThresholds {
  readonly actThreshold: number;
  readonly confirmThreshold: number;
  readonly reversibleGate: number;
  readonly externalGate: number;
  readonly consequenceCeiling: number;
}

function isPluginThresholds(value: unknown): value is PluginThresholds {
  return (
    isRecord(value) &&
    isNumber(value.actThreshold) &&
    isNumber(value.confirmThreshold) &&
    isNumber(value.reversibleGate) &&
    isNumber(value.externalGate) &&
    isNumber(value.consequenceCeiling)
  );
}

export interface PluginConfig {
  readonly thresholds: PluginThresholds;
  readonly logMaxEntries: number;
  readonly jevBudgetMs: number;
}

function isPluginConfig(value: unknown): value is PluginConfig {
  return isRecord(value) && isPluginThresholds(value.thresholds) && isNumber(value.logMaxEntries) && isNumber(value.jevBudgetMs);
}

// Same threshold values already validated against the live API in
// tools/decide.ts and adapters/claude/gate-bash.ts -- see decisions.ts's gate
// constants. Kept here as the *editable* defaults; decisions.ts's own
// constants remain the source of truth for the CLI/hook entry points that
// do not read plugin config.
const DEFAULT_CONFIG: PluginConfig = {
  thresholds: { actThreshold: 0.9, confirmThreshold: 0.6, reversibleGate: 0.7, externalGate: 0.35, consequenceCeiling: 1.5 },
  logMaxEntries: 500,
  jevBudgetMs: 4_000,
};

export async function getConfig(host: StorageHost): Promise<PluginConfig> {
  return readKey(host, STORAGE_KEY.config, isPluginConfig, DEFAULT_CONFIG);
}

export async function setConfig(host: StorageHost, config: PluginConfig): Promise<void> {
  await host.set(STORAGE_KEY.config, config);
}
