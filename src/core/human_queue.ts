// 0.6.8 T4/T5: the queue of actions waiting for a person.
//
// In queue mode ("when a person must approve: queue and continue"), the
// first `requires_human` stop of a command in a session is not put to a
// person who is not there: the agent is told the action is queued, not to
// retry it or work around it, and to carry on. gate-bash.ts appends one
// `queued` line here; the board's "Waiting for you" list reads it back.
//
// A queued command is never run by the queue. The only way forward is the
// same command again, in the same session -- which the agent only does when
// the person, now present, tells it to -- and that retry is ASKED normally
// (never passed): gate-bash.ts appends an `asked` line for its key, which
// takes the item off the waiting list, because the person is being asked
// right then.
//
// The file lives in the cache dir, next to gate-decisions.jsonl. The command
// is stored redacted (secret_redaction.ts, the same masking a Jev request
// gets) and cut to a readable length: it is what the board shows a person,
// never something to replay. The key is a hash of (session, command), so the
// retry check needs neither the session id nor the raw command on disk.
//
// Pure: no fs, no clock beyond an injected `now`.

import { createHash } from "node:crypto";

import { redactSecretsForJev } from "./secret_redaction.ts";

/** The queue's file name inside the cache dir -- one constant for the writer (gate-bash.ts) and the reader (the board's worker). */
export const HUMAN_QUEUE_FILE = "human-queue.jsonl";

/** Enough to recognise the command on the board; the full text is never needed there. */
export const QUEUED_COMMAND_MAX_CHARS = 200;

/** An item nobody came back for in a week is no longer "waiting": the session that queued it is long gone. */
export const WAITING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface QueuedItem {
  readonly type: "queued";
  readonly id: string;
  readonly at: string;
  /** humanQueueKey(sessionId, command): what an identical retry is matched by. */
  readonly key: string;
  readonly project: string | null;
  readonly policyId: string;
  /** Redacted and cut to QUEUED_COMMAND_MAX_CHARS. */
  readonly command: string;
}

export interface AskedEntry {
  readonly type: "asked";
  readonly key: string;
  readonly at: string;
}

export type HumanQueueEntry = QueuedItem | AskedEntry;

/** The key for one (session, command) pair. The NUL separator keeps ("s1", "2x") apart from ("s12", "x"). */
export function humanQueueKey(sessionId: string, command: string): string {
  return createHash("sha256").update(`queue\u0000${sessionId}\u0000${command}`).digest("hex").slice(0, 32);
}

function cutForBoard(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= QUEUED_COMMAND_MAX_CHARS ? trimmed : `${trimmed.slice(0, QUEUED_COMMAND_MAX_CHARS - 1)}…`;
}

export interface BuildQueuedItemInput {
  readonly id: string;
  readonly at: string;
  readonly sessionId: string;
  readonly command: string;
  readonly project: string | null;
  readonly policyId: string;
}

export function buildQueuedItem(input: BuildQueuedItemInput): QueuedItem {
  return {
    type: "queued",
    id: input.id,
    at: input.at,
    key: humanQueueKey(input.sessionId, input.command),
    project: input.project,
    policyId: input.policyId,
    command: cutForBoard(redactSecretsForJev(input.command).text),
  };
}

export function buildAskedEntry(input: { readonly key: string; readonly at: string }): AskedEntry {
  return { type: "asked", key: input.key, at: input.at };
}

export function serializeHumanQueueEntry(entry: HumanQueueEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function isQueuedItem(value: Record<string, unknown>): boolean {
  return (
    value.type === "queued" &&
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    typeof value.key === "string" &&
    (value.project === null || typeof value.project === "string") &&
    typeof value.policyId === "string" &&
    typeof value.command === "string"
  );
}

function isAskedEntry(value: Record<string, unknown>): boolean {
  return value.type === "asked" && typeof value.key === "string" && typeof value.at === "string";
}

/** Reads the file back tolerantly: a malformed, partial or foreign line is skipped, never thrown on. Order is the file's (append) order. */
export function parseHumanQueue(raw: string): readonly HumanQueueEntry[] {
  const entries: HumanQueueEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (isQueuedItem(record)) {
      entries.push({
        type: "queued",
        id: record.id as string,
        at: record.at as string,
        key: record.key as string,
        project: record.project as string | null,
        policyId: record.policyId as string,
        command: record.command as string,
      });
    } else if (isAskedEntry(record)) {
      entries.push({ type: "asked", key: record.key as string, at: record.at as string });
    }
  }
  return entries;
}

/** Whether the latest word on `key` is a `queued` line: the command was queued in this session and its retry has not been put to the person yet. */
export function isQueuedInSession(entries: readonly HumanQueueEntry[], key: string): boolean {
  let queued = false;
  for (const entry of entries) {
    if (entry.key !== key) continue;
    queued = entry.type === "queued";
  }
  return queued;
}

/** The items still waiting for a person: the latest `queued` line of each key with no `asked` after it, younger than WAITING_MAX_AGE_MS, newest first. */
export function waitingItems(entries: readonly HumanQueueEntry[], now: number): readonly QueuedItem[] {
  const latest = new Map<string, HumanQueueEntry>();
  for (const entry of entries) latest.set(entry.key, entry);
  const waiting: QueuedItem[] = [];
  for (const entry of latest.values()) {
    if (entry.type !== "queued") continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || now - at > WAITING_MAX_AGE_MS) continue;
    waiting.push(entry);
  }
  return waiting.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
