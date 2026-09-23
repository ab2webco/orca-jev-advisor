// Append-only decision log: bounded, oldest entries trimmed once the
// configured cap is reached. This is the file that makes thresholds
// calibratable and the whole advisor demonstrable -- it is a first-class
// feature, not debug output, and both adapters (the Orca plugin and the
// Claude Code gate) write to it through this same module so a human
// reviewing "what did the advisor decide, and was it right" only ever
// has to look in one place.
//
// Every entry records: when it was judged, what was judged, the raw Jev
// answers behind the verdict, the verdict itself, and -- filled in later,
// out of band -- whether a human overrode it. Storage access goes through
// store.ts's getLog/setLog, which own validation of the raw shape; this
// module owns the domain behavior on top (append, trim, mark-overridden).

import type { Answer } from "./jev.ts";
import type { LogEntryRaw, StorageHost } from "./store.ts";
import { getConfig, getLog, setLog } from "./store.ts";

export type DecisionKind = "destination" | "action" | "complexity";

export interface DecisionLogEntry {
  readonly id: string;
  /** ISO 8601 timestamp of when the decision was recorded. */
  readonly at: string;
  readonly kind: DecisionKind;
  /** What was judged: the action text, the command, or the task description. */
  readonly judged: string;
  /** The raw Jev answers behind the verdict -- kept for calibration, not just the final label. */
  readonly rawAnswers: Record<string, Answer>;
  /** The final verdict as a short label (e.g. 'act', 'allow', 'avanzado'). */
  readonly verdict: string;
  readonly overriddenAt: string | null;
  readonly overriddenBy: string | null;
  readonly overrideNote: string | null;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toRaw(entry: DecisionLogEntry): LogEntryRaw {
  return { ...entry, rawAnswers: entry.rawAnswers as unknown as Record<string, unknown> };
}

function fromRaw(entry: LogEntryRaw): DecisionLogEntry {
  return { ...entry, kind: entry.kind as DecisionKind, rawAnswers: entry.rawAnswers as unknown as Record<string, Answer> };
}

export interface RecordDecisionInput {
  readonly kind: DecisionKind;
  readonly judged: string;
  readonly rawAnswers: Record<string, Answer>;
  readonly verdict: string;
}

/**
 * Appends one entry to the log, trimming the oldest entries once
 * `config.logMaxEntries` is exceeded. Returns the entry as recorded
 * (including its generated id and timestamp) so the caller can, e.g.,
 * reference it later from a notification or a UI action.
 */
export async function recordDecision(host: StorageHost, input: RecordDecisionInput): Promise<DecisionLogEntry> {
  const [config, existing] = await Promise.all([getConfig(host), getLog(host)]);

  const entry: DecisionLogEntry = {
    id: randomId(),
    at: new Date().toISOString(),
    overriddenAt: null,
    overriddenBy: null,
    overrideNote: null,
    ...input,
  };

  const updated = [...existing, toRaw(entry)];
  const trimmed = updated.length > config.logMaxEntries ? updated.slice(updated.length - config.logMaxEntries) : updated;
  await setLog(host, trimmed);
  return entry;
}

/**
 * Marks an existing entry as having been overridden by a human, so the
 * log can later answer "how often was the advisor's verdict actually
 * followed" -- the calibration signal this log exists to produce.
 * Returns false if no entry with that id exists (never throws).
 */
export async function recordOverride(host: StorageHost, id: string, overriddenBy: string, note: string | null = null): Promise<boolean> {
  const existing = await getLog(host);
  const index = existing.findIndex((entry) => entry.id === id);
  if (index === -1) return false;

  const updated = existing.map((entry, i) =>
    i === index ? { ...entry, overriddenAt: new Date().toISOString(), overriddenBy, overrideNote: note } : entry,
  );
  await setLog(host, updated);
  return true;
}

/** Reads the full log, newest entries last (append order), as typed domain entries. */
export async function readDecisionLog(host: StorageHost): Promise<readonly DecisionLogEntry[]> {
  const raw = await getLog(host);
  return raw.map(fromRaw);
}
