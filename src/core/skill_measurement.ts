// Builds the JSONL records measurement mode writes -- the feature
// document's actual deliverable (odd/tasks/mod-skills.md, T6): "a week of
// that record is enough to fix the thresholds with our own data." Pure
// data shaping only; the mod does the actual file append through `$.fs`.
//
// Two record kinds, correlated by `id` rather than written as one, because
// they arrive at different times from different hooks: `prompt.submit`
// knows what Jev would have chosen the instant both stages answer, but
// whether the model reached for a skill on its own is only known later,
// from a `skill.prompt` hook that may fire on the same turn, on a later
// one, or never. Appending a second line when it does is the only option
// once the first line is already on disk (this module writes no other
// format, JSONL is append-only by construction).

export type MeasurementMode = "measurement" | "active";

export interface WideMeasurement {
  readonly ranked: readonly { readonly name: string; readonly probability: number }[];
  readonly gate: number | null;
  readonly needsSkill: boolean;
}

export interface FitMeasurement {
  readonly winner: string | null;
  readonly fits: Record<string, number>;
}

export interface DecisionRecord {
  readonly type: "decision";
  readonly id: string;
  readonly at: string;
  readonly mode: MeasurementMode;
  readonly prompt: string;
  readonly orcaContext: { readonly worktree: string | null; readonly proyecto: string | null; readonly rama: string | null };
  readonly candidateCount: number;
  /**
   * The exact character count of the roster as the engine's own listing
   * would have rendered it (one `- name: description` line per candidate)
   * -- measured, not estimated: the mod already has every candidate's
   * name and description in memory to build this number from. This is
   * what "characters not sent" multiplies by prompt count on the advisor
   * panel; it is never turned into a time or a cost, which nothing here
   * measures.
   */
  readonly listingChars: number;
  readonly wide: WideMeasurement | null;
  readonly fit: FitMeasurement | null;
  readonly decision: { readonly name: string | null; readonly reason: string };
  readonly latencyMs: { readonly wide: number | null; readonly fit: number | null };
}

export interface ObservationRecord {
  readonly type: "observation";
  readonly id: string;
  readonly at: string;
  readonly skill: string;
}

export type MeasurementRecord = DecisionRecord | ObservationRecord;

export interface BuildDecisionRecordInput {
  readonly id: string;
  readonly at: string;
  readonly mode: MeasurementMode;
  readonly prompt: string;
  readonly orcaContext: { readonly worktree: string | null; readonly proyecto: string | null; readonly rama: string | null };
  readonly candidateCount: number;
  readonly listingChars: number;
  readonly wide: WideMeasurement | null;
  readonly fit: FitMeasurement | null;
  readonly decision: { readonly name: string | null; readonly reason: string };
  readonly latencyMs: { readonly wide: number | null; readonly fit: number | null };
}

export function buildDecisionRecord(input: BuildDecisionRecordInput): DecisionRecord {
  return { type: "decision", ...input };
}

export function buildObservationRecord(id: string, skill: string, at: string): ObservationRecord {
  return { type: "observation", id, at, skill };
}

/** One JSONL line, newline-terminated, ready to append. */
export function serializeRecord(record: MeasurementRecord): string {
  return `${JSON.stringify(record)}\n`;
}
