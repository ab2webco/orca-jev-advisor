// The gate's own append-only JSONL record -- same discipline as
// src/core/skill_measurement.ts (id/at, one line per event, never the raw
// payload), applied to adapters/claude/gate-bash.ts so the advisor panel
// can show what Jev actually did instead of a cache of opaque ids.
//
// Deliberately narrow: never the literal command (it can carry a secret
// in an env assignment, a URL, a token pasted into an argument), never
// which specific file or branch, only a coarse command *family* (`git
// push`, `rm -rf`, `terraform`, ...) and which project it happened in.

import { startsWithGitDiscard } from "./git_discard.ts";

/**
 * `"none"` means the gate reached the point of asking Jev and got no answer
 * back at all -- network error, timeout, or budget exceeded (see askJev in
 * adapters/claude/gate-bash.ts) -- so the command passed through unjudged.
 * That is different from the DECISION, which is always `"allow"` for a
 * `"none"` record: failing open on the decision is correct and must stay,
 * this bucket exists only so failing open on the VISIBILITY of that fact
 * stops being silent.
 */
export type GateSource = "local-rule" | "cache" | "jev" | "none";
export type GateVerdict = "allow" | "ask" | "deny";

/**
 * WHY the gate produced this decision -- finer than `source` above, which
 * only says which STAGE decided (a local pattern, the cache, Jev, or nobody)
 * and, for `source: "jev"`, conflates two very different reasons: a team
 * policy resolved it (`interpretDestinationPolicy` in decisions.ts) or the
 * consequence-ceiling risk rule did (`decideAction`). Of 170 historical asks
 * on one real machine, 82 carried no risk scores at all -- policy stops,
 * local-rule asks and cache hits all look identical in that respect, and
 * nothing could tell them apart. This field is that distinction, made
 * explicit instead of inferred:
 *
 *   "policy"     -- a team policy's `prohibits`/`requires_human` matched
 *                    (see GateDecisionRecord.policyId below for which one).
 *   "local-rule"  -- one of gate-bash.ts's own NEVER_SILENTLY patterns.
 *   "risk"        -- decideAction's reversible/external/consequence axes.
 *   "unreachable" -- Jev was asked but never answered (source: "none");
 *                    the verdict is still a truthful "allow" (failing open
 *                    is correct), this only names why nobody actually judged.
 *   "cache"       -- a prior verdict was replayed; the cache does not keep
 *                    which of the reasons above produced the original one,
 *                    so "cache" is the honest, complete answer on its own.
 *
 * Reuses GateSource's own vocabulary wherever the two line up exactly
 * (local-rule, cache) rather than inventing parallel names for the same
 * thing -- only the "jev" bucket needed splitting, into "policy" and "risk",
 * and "none" is renamed to the reader-facing "unreachable".
 */
export type GateStopReason = "policy" | "local-rule" | "risk" | "unreachable" | "cache";

export interface GateDecisionRecord {
  readonly type: "gate-decision";
  readonly id: string;
  readonly at: string;
  readonly project: string | null;
  readonly commandFamily: string;
  readonly source: GateSource;
  readonly verdict: GateVerdict;
  /** Only meaningful for `source: "jev"`; null for a local-rule or cache verdict, which never call the network. */
  readonly latencyMs: number | null;
  /**
   * Which plugin build produced this decision (e.g. `"0.4.0"`).
   *
   * Optional ON READ, not on write: every new record is stamped with the
   * build that wrote it, but a record already on disk from before this
   * field existed simply lacks the key. That absence is exactly the case
   * this field exists to make visible -- five `ask` records for the
   * pipe-to-shell family looked like the deny tier failing until their
   * version showed they predated 0.4.0, the release that introduced the
   * deny tier at all. A time filter cannot separate that; the version can.
   * A record missing this field must never be dropped or treated as
   * corrupt -- see parseGateDecisionRecords below.
   */
  readonly pluginVersion?: string;
  /**
   * Optional ON READ, not on write: same discipline as `pluginVersion`
   * above. Every record `buildGateDecisionRecord` writes from 0.5.1 on
   * carries one -- a `gate-decision` record is always written at the exact
   * moment the gate has just decided why, so this is never genuinely
   * unknown at write time -- but a record already on disk from before this
   * field existed simply lacks the key, and must parse back that way, never
   * dropped and never treated as corrupt.
   */
  readonly stopReason?: GateStopReason;
  /**
   * The policy that resolved this decision -- present only when
   * `stopReason` is `"policy"`. The id only, never the command or the
   * policy's rule text: same privacy rule as every other field in this
   * file.
   */
  readonly policyId?: string;
}

/** The family for discarding uncommitted work. Records written before checkout and restore joined it carry `LEGACY_DISCARD_FAMILY`. */
export const DISCARD_FAMILY = "git discard";
const LEGACY_DISCARD_FAMILY = "git reset/clean";

/**
 * The family a record on disk belongs to today. `commandFamily` is stamped
 * at write time, so a log spanning the rename would otherwise show the same
 * family twice.
 */
export function canonicalCommandFamily(family: string): string {
  return family === LEGACY_DISCARD_FAMILY ? DISCARD_FAMILY : family;
}

/** `spansPipe` marks a shape that only exists ACROSS a pipe, so it must be matched before the command is split. */
const FAMILY_PATTERNS: readonly { readonly pattern: { test(segment: string): boolean }; readonly family: string; readonly spansPipe?: boolean }[] = [
  { pattern: /^git\s+push\b/, family: "git push" },
  // Every way of throwing away uncommitted work in one family: reset and
  // clean as before, plus checkout/restore in the forms that overwrite the
  // working tree (see git_discard.ts). `git checkout <branch>` stays `git`.
  {
    pattern: { test: (segment) => /^git\s+(reset|clean)\b/.test(segment) || startsWithGitDiscard(segment) },
    family: DISCARD_FAMILY,
  },
  { pattern: /^git\s+branch\b/, family: "git branch" },
  { pattern: /^rm\s+-[a-zA-Z]*[rf]/, family: "rm -rf" },
  { pattern: /^kubectl\b/, family: "kubectl" },
  { pattern: /^(terraform|tofu)\b/, family: "terraform" },
  { pattern: /^docker\b/, family: "docker" },
  { pattern: /^(DROP|TRUNCATE)\b/i, family: "sql drop/truncate" },
  { pattern: /^(psql|mysql)\b/, family: "db client" },
  { pattern: /^aws\b/, family: "aws cli" },
  { pattern: /^(npm|pnpm|yarn|bun)\s+run\b/, family: "package script" },
  { pattern: /^gh\b/, family: "gh cli" },
  { pattern: /(curl|wget)[^|]*\|\s*(bash|sh|zsh)\b/, family: "curl | shell", spansPipe: true },
];

/**
 * The coarsest description of a command that is still useful for "where is
 * this used most": a known risky shape's name, or (fallback) just its
 * first word -- a program name (`npm`, `docker`), never an argument, a
 * path or anything that could hold a secret.
 */
export function commandFamily(command: string): string {
  // Whole command first: some shapes ARE the pipe -- `curl ... | bash` is only
  // dangerous because of what it pipes into, and splitting on `|` destroys it.
  const whole = stripAssignments(command.trim());
  for (const { pattern, family, spansPipe } of FAMILY_PATTERNS) {
    if (spansPipe === true && pattern.test(whole)) return family;
  }
  // Then per segment: a compound command is named after its most dangerous
  // part, not its first word. `cd somewhere && rm -rf dist` filed under `cd`
  // hides exactly what the log exists to surface, and `cd` was 57% of a real
  // log read this way.
  const segments = splitSegments(command);
  for (const { pattern, family } of FAMILY_PATTERNS) {
    for (const segment of segments) {
      if (pattern.test(segment)) return family;
    }
  }
  return programName(segments[0] ?? "");
}

/** Splits on the shell operators that chain commands, so each part can be classified on its own. */
export function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|]/)
    .map((part) => stripAssignments(part.trim()))
    .filter((part) => part.length > 0);
}

/**
 * Drops the `VAR=value` prefixes a command may carry before the program name
 * -- including an `export NAME=value` form, and one with nothing trailing it
 * at all.
 *
 * This is the security-critical half of this module. Without it the fallback
 * below read `TOKEN=ghp_... gh pr merge` as its first word and, after
 * stripping punctuation, wrote `TOKENghp_...` into the log -- the literal
 * secret, in the one file this module promises never to put one in.
 *
 * The terminator used to be `\s+` alone, which required something to follow
 * the assignment. `splitSegments` splits BEFORE this runs, so a command like
 * `DEV=/path/to/project; node run.mjs` handed this function the assignment
 * ALONE as its own segment -- nothing trailing it anymore -- and the regex
 * stopped matching. The fallback then read that unstripped segment as the
 * family's raw material: `programName` found a `/` in the assignment's own
 * VALUE and returned its basename, so a project path (`orca-jev-advisor-dev`)
 * was logged as the family, standing in for a program name it never was.
 * `(?:\s+|$)` accepts the end of the segment as a terminator too, and
 * `splitSegments` already filters the empty string this then produces.
 */
export function stripAssignments(segment: string): string {
  return segment.replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$))+/, "");
}

/**
 * The program name alone, or `other`.
 *
 * Deliberately a whitelist, not a strip: anything that is not already a bare
 * program name -- a path, an assignment, a quoted string, a substitution --
 * becomes `other` rather than being punched into shape. Stripping punctuation
 * from an arbitrary token is what turned a secret into a "family" name.
 */
function programName(segment: string): string {
  const first = segment.split(/\s+/)[0] ?? "";
  const base = first.includes("/") ? (first.split("/").pop() ?? "") : first;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/.test(base) ? base : "other";
}

export interface BuildGateDecisionRecordInput {
  readonly id: string;
  readonly at: string;
  readonly project: string | null;
  readonly command: string;
  readonly source: GateSource;
  readonly verdict: GateVerdict;
  readonly latencyMs: number | null;
  /** Required at construction time: whoever builds a record today always knows the build producing it. */
  readonly pluginVersion: string;
  /** Required at construction time: whoever builds a record today always knows why (see GateStopReason above). */
  readonly stopReason: GateStopReason;
  /** Only meaningful (and only ever passed) when `stopReason` is `"policy"`. */
  readonly policyId?: string;
}

export function buildGateDecisionRecord(input: BuildGateDecisionRecordInput): GateDecisionRecord {
  return {
    type: "gate-decision",
    id: input.id,
    at: input.at,
    project: input.project,
    commandFamily: commandFamily(input.command),
    source: input.source,
    verdict: input.verdict,
    latencyMs: input.latencyMs,
    // Conditionally spread, not `pluginVersion: input.pluginVersion`: an
    // explicit `pluginVersion: undefined` key is a different shape than a
    // truly absent one for JSON.stringify's own output (it drops the key
    // either way) but NOT for object equality on the in-memory record, and
    // this record must be indistinguishable from one parsed back off disk
    // where the key never existed at all.
    ...(input.pluginVersion !== undefined ? { pluginVersion: input.pluginVersion } : {}),
    // Same conditional-spread reasoning as pluginVersion above, even though
    // stopReason is declared required on the input: a caller (or an older
    // test, or a future one) that leaves it out at runtime must not produce
    // a `stopReason: undefined` key, which JSON.stringify drops but which
    // an in-memory `assert.deepEqual` against a round-tripped record would
    // still see as a shape mismatch.
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    // Same conditional-spread reasoning as pluginVersion above: a policyId
    // key that is present-but-undefined is a different shape than a truly
    // absent one, and every non-"policy" stop must produce a record
    // byte-for-byte indistinguishable from one that never had this field.
    ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
  };
}

export function serializeGateRecord(record: GateDecisionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isGateSource(value: unknown): value is GateSource {
  return value === "local-rule" || value === "cache" || value === "jev" || value === "none";
}

function isGateVerdict(value: unknown): value is GateVerdict {
  return value === "allow" || value === "ask" || value === "deny";
}

function isGateStopReason(value: unknown): value is GateStopReason {
  return value === "policy" || value === "local-rule" || value === "risk" || value === "unreachable" || value === "cache";
}

function isGateDecisionRecord(value: unknown): value is GateDecisionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "gate-decision" &&
    typeof record.id === "string" &&
    typeof record.at === "string" &&
    (record.project === null || typeof record.project === "string") &&
    typeof record.commandFamily === "string" &&
    isGateSource(record.source) &&
    isGateVerdict(record.verdict) &&
    (record.latencyMs === null || typeof record.latencyMs === "number") &&
    // Absent entirely (a record written before this field existed) is valid;
    // present-but-wrong-type is not, same discipline as every other field.
    (record.pluginVersion === undefined || typeof record.pluginVersion === "string") &&
    (record.stopReason === undefined || isGateStopReason(record.stopReason)) &&
    (record.policyId === undefined || typeof record.policyId === "string")
  );
}

/**
 * Reads `gate-decisions.jsonl` back, tolerantly -- same discipline as
 * approval_record.ts's parsePendingToolUseIds: a malformed or incomplete
 * line is skipped, never thrown on. Added for the AB benchmark's own report
 * (adapters/cli/ab_benchmark_cli.ts): counting this log's `source: "jev"`
 * entries is how it reports "how many of Jev's real decisions the large
 * model never had to see" -- a real measurement from the log this plugin
 * already writes, never an estimate.
 */
export function parseGateDecisionRecords(raw: string): readonly GateDecisionRecord[] {
  const records: GateDecisionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isGateDecisionRecord(parsed)) records.push(parsed);
  }
  return records;
}
