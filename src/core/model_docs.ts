// ---------------------------------------------------------------------------
// The daily docs check: Anthropic's public models overview and pricing pages,
// read as markdown and turned into model catalog rows.
//
// The rows never touch routing by themselves. They become a "docs seed": a
// newer baseline offered through the same notice as a shipped seed
// (model_seed_notice.ts), so nothing changes until the person accepts it.
//
// The fetched text is data, never instructions: only the table cells named
// below are read, every value is parsed into a strict shape (an id pattern,
// a known effort level, a number of tokens, a price, an ISO date), and a
// page whose shape changed yields no rows rather than a partial guess.
//
// Pure, like the rest of src/core: the worker fetches and stores.
// ---------------------------------------------------------------------------

import { isRecord, isString } from "../guards.ts";
import { parseModelCatalog, parseModelSeedEntries, parseModelSeedVersion, isModelEntry } from "./model_catalog.ts";
import type { ModelEntry, ModelPrices, RouterTier } from "./model_catalog.ts";
import { diffModelSeed } from "./model_seed_notice.ts";

export const MODELS_OVERVIEW_URL = "https://platform.claude.com/docs/en/about-claude/models/overview";
export const MODELS_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";

export const MODEL_DOCS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_ID_LENGTH = 80;
const MAX_LABEL_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 200;
const MAX_MODELS = 20;
const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** What the overview page says about one model; a field it does not state is absent. */
export interface OverviewModel {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly supportsEffort?: boolean;
  readonly defaultEffort?: string;
  readonly contextWindow?: number;
  readonly retiresNotBefore?: string;
}

// ---------------------------------------------------------------------------
// Markdown tables
// ---------------------------------------------------------------------------

type Table = readonly (readonly string[])[];

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Every pipe table in the page, header row first, separator rows dropped. */
function markdownTables(markdown: string): Table[] {
  const tables: string[][][] = [];
  let current: string[][] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      current = null;
      continue;
    }
    const cells = splitRow(line);
    if (current === null) {
      current = [];
      tables.push(current);
    }
    if (!isSeparatorRow(cells)) current.push(cells);
  }
  return tables;
}

/** A cell as plain text: links become their text, code marks, footnotes and tags go. */
function plain(cell: string): string {
  return cell
    .replace(/<sup>.*?<\/sup>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

function modelId(cell: string): string | null {
  const id = plain(cell);
  return id.length <= MAX_ID_LENGTH && MODEL_ID.test(id) ? id : null;
}

function effort(cell: string): { supportsEffort?: boolean; defaultEffort?: string } {
  const text = plain(cell).toLowerCase();
  if (text === "not supported") return { supportsEffort: false };
  return EFFORT_LEVELS.includes(text) ? { supportsEffort: true, defaultEffort: text } : {};
}

function tokens(cell: string): number | undefined {
  const match = /^([\d.,]+)\s*([km])?\s+tokens$/i.exec(plain(cell));
  if (match === null) return undefined;
  const value = Number((match[1] as string).replace(/,/g, ""));
  const unit = match[2]?.toLowerCase();
  const scaled = unit === "m" ? value * 1_000_000 : unit === "k" ? value * 1_000 : value;
  return Number.isInteger(scaled) && scaled > 0 ? scaled : undefined;
}

const MONTHS: readonly string[] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function retirement(cell: string): string | undefined {
  const match = /^not sooner than ([a-z]+) (\d{1,2}), (\d{4})$/i.exec(plain(cell));
  if (match === null) return undefined;
  const month = MONTHS.indexOf((match[1] as string).toLowerCase()) + 1;
  if (month === 0) return undefined;
  const iso = `${match[3]}-${String(month).padStart(2, "0")}-${(match[2] as string).padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function price(cell: string): number | undefined {
  const match = /^\$([\d.]+) \/ MTok$/.exec(plain(cell));
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// The two pages
// ---------------------------------------------------------------------------

/** The overview's comparison table: one model per column, keyed by its "Claude API ID" row. */
export function parseModelsOverview(markdown: string): readonly OverviewModel[] {
  const table = markdownTables(markdown).find((rows) => rows.some((row) => plain(row[0] ?? "") === "Claude API ID"));
  if (table === undefined || table.length < 2) return [];
  const header = table[0] as readonly string[];
  const rowNamed = (name: string): readonly string[] | undefined => table.find((row) => plain(row[0] ?? "") === name);
  const ids = rowNamed("Claude API ID") as readonly string[];
  const models: OverviewModel[] = [];
  for (let column = 1; column < header.length && models.length < MAX_MODELS; column += 1) {
    const id = modelId(ids[column] ?? "");
    const label = plain(header[column] ?? "");
    if (id === null || label.length === 0 || label.length > MAX_LABEL_LENGTH) continue;
    const summary = plain(rowNamed("Description")?.[column] ?? "");
    const window = tokens(rowNamed("Context window")?.[column] ?? "");
    const retires = retirement(rowNamed("Retirement")?.[column] ?? "");
    models.push({
      id,
      label,
      ...(summary.length > 0 && summary.length <= MAX_SUMMARY_LENGTH ? { summary } : {}),
      ...effort(rowNamed("Default effort")?.[column] ?? ""),
      ...(window === undefined ? {} : { contextWindow: window }),
      ...(retires === undefined ? {} : { retiresNotBefore: retires }),
    });
  }
  return models;
}

/** The "Model pricing" table: model name → list prices, the 1h cache write as `cacheWrite`. */
export function parseModelPricing(markdown: string): ReadonlyMap<string, ModelPrices> {
  const prices = new Map<string, ModelPrices>();
  const table = markdownTables(markdown).find((rows) => (rows[0] ?? []).some((cell) => plain(cell) === "Base input tokens"));
  if (table === undefined) return prices;
  const header = (table[0] as readonly string[]).map(plain);
  const at = (name: string): number => header.indexOf(name);
  const columns = { input: at("Base input tokens"), cacheWrite: at("1h cache writes"), cacheRead: at("Cache hits and refreshes"), output: at("Output tokens") };
  if (Object.values(columns).some((index) => index < 1)) return prices;
  for (const row of table.slice(1)) {
    const name = plain(row[0] ?? "").replace(/\s*\(.*\)$/, "");
    const input = price(row[columns.input] ?? "");
    const cacheWrite = price(row[columns.cacheWrite] ?? "");
    const cacheRead = price(row[columns.cacheRead] ?? "");
    const output = price(row[columns.output] ?? "");
    if (name.length === 0 || name.length > MAX_LABEL_LENGTH || input === undefined || cacheWrite === undefined || cacheRead === undefined || output === undefined) continue;
    prices.set(name, { input, cacheWrite, cacheRead, output });
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Rows for the catalog
// ---------------------------------------------------------------------------

type Family = "haiku" | "sonnet" | "opus" | "fable";

const FAMILY_TIER: Readonly<Record<Family, RouterTier>> = { haiku: "simple", sonnet: "standard", opus: "complex", fable: "frontier" };

/** The seed's own convention: rank 1 is the strongest tier. */
const TIER_RANK: Readonly<Record<RouterTier, number>> = { frontier: 1, complex: 2, standard: 3, simple: 4 };

function familyOf(id: string): Family | null {
  const match = /^claude-(haiku|sonnet|opus|fable)-/.exec(id);
  return match === null ? null : (match[1] as Family);
}

/** "Claude Sonnet 5.5" → [5, 5]; no trailing version reads as none. */
function versionOf(label: string): readonly number[] {
  const match = /(\d+(?:\.\d+)*)\s*$/.exec(label);
  return match === null ? [] : (match[1] as string).split(".").map(Number);
}

function newer(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Catalog rows from the two pages. A known family's newest model takes that
 * family's tier and the seed's rank for it; an older one of the same family,
 * and any unknown family, is added unranked (never chosen until the person
 * places it). What the pages do not state -- whether the person runs the
 * model, the Agent alias, which thinking blocks it reads -- comes from the
 * row `known` already carries for that id.
 */
export function docsSeedRows(overview: readonly OverviewModel[], pricing: ReadonlyMap<string, ModelPrices>, known: readonly ModelEntry[]): readonly ModelEntry[] {
  const newest = new Map<Family, OverviewModel>();
  for (const model of overview) {
    const family = familyOf(model.id);
    if (family === null) continue;
    const best = newest.get(family);
    if (best === undefined || newer(versionOf(model.label), versionOf(best.label))) newest.set(family, model);
  }
  const rows: ModelEntry[] = [];
  for (const model of overview) {
    const family = familyOf(model.id);
    const tier = family !== null && newest.get(family) === model ? FAMILY_TIER[family] : undefined;
    const previous = known.find((row) => row.id === model.id);
    const prices = pricing.get(model.label);
    const row: ModelEntry = {
      id: model.id,
      provider: "anthropic",
      label: model.label,
      rank: tier === undefined ? null : TIER_RANK[tier],
      agentModel: previous?.agentModel ?? family ?? model.id,
      ...(model.summary === undefined ? {} : { summary: model.summary }),
      source: MODELS_OVERVIEW_URL,
      available: previous?.available ?? tier !== "frontier",
      ...(tier === undefined ? {} : { tier }),
      ...(prices === undefined ? {} : { prices }),
      ...(model.supportsEffort === undefined ? {} : { supportsEffort: model.supportsEffort }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(previous?.thinkingReadsFrom === undefined ? {} : { thinkingReadsFrom: previous.thinkingReadsFrom }),
      ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
      ...(model.retiresNotBefore === undefined ? {} : { retiresNotBefore: model.retiresNotBefore }),
    };
    if (isModelEntry(row)) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The stored docs seed and when to check again
// ---------------------------------------------------------------------------

export interface DocsSeed {
  readonly version: number;
  readonly fetchedAt: string;
  readonly models: readonly ModelEntry[];
}

export interface OfferedSeed {
  readonly version: number;
  readonly models: readonly ModelEntry[];
}

export function parseDocsSeed(value: unknown): DocsSeed | null {
  if (!isRecord(value) || !isString(value.fetchedAt)) return null;
  const version = value.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return null;
  return { version, fetchedAt: value.fetchedAt, models: parseModelCatalog(value.models) };
}

/**
 * The docs seed after a successful read. Rows that add or change nothing
 * against what is already offered (the stored docs seed, or the shipped
 * seed when that is as new) keep its version, so an unchanged page never
 * re-offers anything; any difference is one version newer.
 */
export function nextDocsSeed(previous: DocsSeed | null, rows: readonly ModelEntry[], shipped: OfferedSeed, fetchedAt: string): DocsSeed {
  const base: OfferedSeed = previous !== null && previous.version >= shipped.version ? previous : shipped;
  const diff = diffModelSeed(base.models, rows);
  const same = diff.added.length === 0 && diff.differing.length === 0;
  return { version: same ? base.version : base.version + 1, fetchedAt, models: rows };
}

/** The seed payload to offer: the docs seed when it is newer than the shipped one, else the shipped payload itself. */
export function effectiveModelSeed(shippedPayload: unknown, docs: DocsSeed | null): unknown {
  if (docs === null || docs.version <= parseModelSeedVersion(shippedPayload)) return shippedPayload;
  return { version: docs.version, models: docs.models };
}

/** The shipped payload as an offer, for nextDocsSeed. */
export function shippedOffer(shippedPayload: unknown): OfferedSeed {
  return { version: parseModelSeedVersion(shippedPayload), models: parseModelSeedEntries(shippedPayload) };
}

export interface DocsCheck {
  readonly at: string;
}

/** Due when never attempted, or when the last attempt (a failed one too) is a day old. */
export function docsCheckDue(last: DocsCheck | null, nowMs: number): boolean {
  if (last === null) return true;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || nowMs - at >= MODEL_DOCS_CHECK_INTERVAL_MS;
}

export function parseDocsCheck(value: unknown): DocsCheck | null {
  return isRecord(value) && isString(value.at) ? { at: value.at } : null;
}
