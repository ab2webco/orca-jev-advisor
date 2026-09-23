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

const FAMILY_PATTERNS: readonly { readonly pattern: RegExp; readonly family: string }[] = [
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
  { pattern: /curl[^|]*\|\s*(bash|sh|zsh)\b/, family: "curl | shell" },
];

/**
 * The coarsest description of a command that is still useful for "where is
 * this used most": a known risky shape's name, or (fallback) just its
 * first word -- a program name (`npm`, `docker`), never an argument, a
 * path or anything that could hold a secret.
 */
export function commandFamily(command: string): string {
  const trimmed = command.trim();
  for (const { pattern, family } of FAMILY_PATTERNS) {
    if (pattern.test(trimmed)) return family;
  }
  const firstWord = (trimmed.split(/\s+/)[0] ?? "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return firstWord.length > 0 ? firstWord.slice(0, 24) : "other";
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
