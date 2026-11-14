// JEVADV-112: how much the engine's skill listing is re-read, and what
// withholding it keeps out. Pure: the CLI (adapters/cli/skill_listing_measure_cli.ts)
// reads the files and hands the parsed rows here.
//
// Two sources:
//   - Claude Code transcripts (`<config>/projects/*/*.jsonl`): every
//     `skill_listing` attachment row, and every main-loop model request
//     (one distinct assistant `message.id`) after it, up to the next
//     compaction. That is the listing's real cost, withheld or not.
//   - The mod's own rows (mod-skills `listing` and `withheld-use`, and the
//     router's turn-usage rows): which sessions' listings were actually
//     withheld, the main steps each session ran after it, and the skills
//     loaded after one was withheld.
//
// Tokens are estimated as characters / 4, the same figure the ticket's
// baseline uses (33,924 characters, about 8,500 tokens).

import { isRecord } from "../guards.ts";

export const CHARS_PER_TOKEN = 4;

export interface TranscriptListing {
  /** Characters of the listing's own text. */
  readonly chars: number;
  readonly isInitial: boolean | null;
  /** Main-loop model requests that carried it: after it, before the next compaction. */
  readonly requestsCarrying: number;
}

export interface TranscriptMeasure {
  readonly listings: readonly TranscriptListing[];
  /** Person-typed prompts (plain-text user rows that are not meta). */
  readonly prompts: number;
  /** Distinct main-loop model requests in the whole transcript. */
  readonly requests: number;
  readonly compactions: number;
}

function attachmentOf(row: Record<string, unknown>): Record<string, unknown> | null {
  return row.type === "attachment" && isRecord(row.attachment) ? row.attachment : null;
}

function listingChars(attachment: Record<string, unknown>): number {
  const content = attachment.content;
  if (typeof content === "string") return content.length;
  return JSON.stringify(content ?? "").length;
}

/** One transcript's listings and the requests that re-read each one. */
export function measureTranscript(rows: readonly unknown[]): TranscriptMeasure {
  const listings: { chars: number; isInitial: boolean | null; requestsCarrying: number }[] = [];
  let open: { chars: number; isInitial: boolean | null; requestsCarrying: number }[] = [];
  const seen = new Set<string>();
  let prompts = 0;
  let compactions = 0;
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const attachment = attachmentOf(raw);
    if (attachment !== null && attachment.type === "skill_listing") {
      const listing = { chars: listingChars(attachment), isInitial: typeof attachment.isInitial === "boolean" ? attachment.isInitial : null, requestsCarrying: 0 };
      listings.push(listing);
      open.push(listing);
      continue;
    }
    if (raw.type === "system" && raw.subtype === "compact_boundary") {
      compactions += 1;
      open = [];
      continue;
    }
    if (raw.type === "user" && raw.isMeta !== true && raw.isSidechain !== true && isRecord(raw.message) && typeof raw.message.content === "string") {
      prompts += 1;
      continue;
    }
    if (raw.type === "assistant" && raw.isSidechain !== true && isRecord(raw.message) && typeof raw.message.id === "string" && !seen.has(raw.message.id)) {
      seen.add(raw.message.id);
      for (const listing of open) listing.requestsCarrying += 1;
    }
  }
  return { listings, prompts, requests: seen.size, compactions };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface TranscriptSummary {
  readonly sessions: number;
  readonly sessionsWithListing: number;
  /** Listing rows per session that had one: [min, max]. 1/1 means once per session. */
  readonly listingsPerSession: readonly [number, number] | null;
  readonly initialListings: number;
  readonly medianPrompts: number | null;
  readonly medianListingChars: number | null;
  readonly medianRequestsCarrying: number | null;
  /** Listing tokens re-read in a median session: median chars / 4 x median requests carrying it. */
  readonly medianSessionReReadTokens: number | null;
}

export function summarizeTranscripts(measures: readonly TranscriptMeasure[]): TranscriptSummary {
  const withListing = measures.filter((m) => m.listings.length > 0);
  const counts = withListing.map((m) => m.listings.length);
  const chars = withListing.flatMap((m) => m.listings.map((l) => l.chars));
  const carrying = withListing.map((m) => m.listings.reduce((total, l) => total + l.requestsCarrying, 0));
  const medianChars = median(chars);
  const medianCarrying = median(carrying);
  const prompts = median(withListing.map((m) => m.prompts));
  return {
    sessions: measures.length,
    sessionsWithListing: withListing.length,
    listingsPerSession: counts.length > 0 ? [Math.min(...counts), Math.max(...counts)] : null,
    initialListings: withListing.reduce((total, m) => total + m.listings.filter((l) => l.isInitial === true).length, 0),
    medianPrompts: prompts,
    medianListingChars: medianChars,
    medianRequestsCarrying: medianCarrying,
    medianSessionReReadTokens: medianChars === null || medianCarrying === null ? null : Math.round((medianChars / CHARS_PER_TOKEN) * medianCarrying),
  };
}

// ---------------------------------------------------------------------------
// The mod's own rows
// ---------------------------------------------------------------------------

export interface WithheldSession {
  readonly sessionId: string;
  readonly reason: string;
  readonly chars: number;
  /** Main-loop steps the turn-usage log recorded for this session at or after the withhold. */
  readonly stepsAfter: number;
  readonly tokensKeptOut: number;
  readonly skillsUsedAfter: readonly string[];
}

export interface WithholdSummary {
  readonly listingsAsked: number;
  readonly withheld: readonly WithheldSession[];
  readonly byReason: Record<string, { sessions: number; tokensKeptOut: number; skillUsesAfter: number }>;
}

/** Joins mod-skills `listing`/`withheld-use` rows with turn-usage rows by session. */
export function summarizeWithholds(skillRows: readonly unknown[], usageRows: readonly unknown[]): WithholdSummary {
  const listings = skillRows.filter((row): row is Record<string, unknown> => isRecord(row) && row.type === "listing");
  const uses = skillRows.filter((row): row is Record<string, unknown> => isRecord(row) && row.type === "withheld-use" && typeof row.sessionId === "string");
  const steps = usageRows.filter((row): row is Record<string, unknown> => isRecord(row) && row.agent === "main" && typeof row.sessionId === "string" && typeof row.at === "string");
  const withheld: WithheldSession[] = [];
  for (const row of listings) {
    if (typeof row.withheld !== "string" || typeof row.sessionId !== "string" || typeof row.chars !== "number" || typeof row.at !== "string") continue;
    const at = row.at;
    const sessionId = row.sessionId;
    const stepsAfter = steps.filter((step) => step.sessionId === sessionId && (step.at as string) >= at).length;
    withheld.push({
      sessionId,
      reason: row.withheld,
      chars: row.chars,
      stepsAfter,
      tokensKeptOut: Math.round((row.chars / CHARS_PER_TOKEN) * stepsAfter),
      skillsUsedAfter: uses.filter((use) => use.sessionId === sessionId && typeof use.skill === "string").map((use) => use.skill as string),
    });
  }
  const byReason: Record<string, { sessions: number; tokensKeptOut: number; skillUsesAfter: number }> = {};
  for (const session of withheld) {
    const entry = (byReason[session.reason] ??= { sessions: 0, tokensKeptOut: 0, skillUsesAfter: 0 });
    entry.sessions += 1;
    entry.tokensKeptOut += session.tokensKeptOut;
    entry.skillUsesAfter += session.skillsUsedAfter.length;
  }
  return { listingsAsked: listings.length, withheld, byReason };
}
