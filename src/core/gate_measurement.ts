// The gate's own append-only JSONL record -- same discipline as
// src/core/skill_measurement.ts (id/at, one line per event, never the raw
// payload), applied to adapters/claude/gate-bash.ts so the advisor panel
// can show what Jev actually did instead of a cache of opaque ids.
//
// Deliberately narrow: never the literal command (it can carry a secret
// in an env assignment, a URL, a token pasted into an argument), never
// which specific file or branch, only a coarse command *family* (`git
// push`, `rm -rf`, `terraform`, ...) and which project it happened in.

export type GateSource = "local-rule" | "cache" | "jev";
export type GateVerdict = "allow" | "ask" | "deny";

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
}

/** `spansPipe` marks a shape that only exists ACROSS a pipe, so it must be matched before the command is split. */
const FAMILY_PATTERNS: readonly { readonly pattern: RegExp; readonly family: string; readonly spansPipe?: boolean }[] = [
  { pattern: /^git\s+push\b/, family: "git push" },
  { pattern: /^git\s+(reset|clean)\b/, family: "git reset/clean" },
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
 * Drops the `VAR=value` prefixes a command may carry before the program name.
 *
 * This is the security-critical half of this module. Without it the fallback
 * below read `TOKEN=ghp_... gh pr merge` as its first word and, after
 * stripping punctuation, wrote `TOKENghp_...` into the log -- the literal
 * secret, in the one file this module promises never to put one in.
 */
export function stripAssignments(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
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
  };
}

export function serializeGateRecord(record: GateDecisionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isGateSource(value: unknown): value is GateSource {
  return value === "local-rule" || value === "cache" || value === "jev";
}

function isGateVerdict(value: unknown): value is GateVerdict {
  return value === "allow" || value === "ask" || value === "deny";
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
    (record.latencyMs === null || typeof record.latencyMs === "number")
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
