// Builds the JSONL records tool-selection measurement mode writes -- the
// same two-record shape skill_measurement.ts uses, so a week of this data
// is what actually calibrates tool_decisions.ts's thresholds, never a
// guess. Pure data shaping only; the mod does the actual file append
// through `$.fs`.
//
// Two record kinds, correlated by `id` rather than written as one, because
// they arrive at different times from different hooks: `prompt.submit`
// knows what Jev would have suggested the instant both stages answer, but
// which tool the model actually reached for is only known later, from a
// `tool.call` hook that may fire on the same turn, on a later one, or
// never. Appending a second line when it does is the only option once the
// first line is already on disk.

export type MeasurementMode = "measurement" | "active";

export interface WideMeasurement {
  readonly ranked: readonly { readonly name: string; readonly probability: number }[];
  readonly gate: number | null;
  readonly needsOneTool: boolean;
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
  readonly orcaContext: { readonly worktree: string | null; readonly project: string | null; readonly branch: string | null };
  readonly candidateCount: number;
  /**
   * The exact character count of the roster as one `- name: description`
   * line per candidate would render -- measured, not estimated: the mod
   * already has every candidate's name and description in memory to build
   * this number from. Never turned into a time or a cost, which nothing
   * here measures.
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
  readonly tool: string;
}

export type MeasurementRecord = DecisionRecord | ObservationRecord;

export interface BuildDecisionRecordInput {
  readonly id: string;
  readonly at: string;
  readonly mode: MeasurementMode;
  readonly prompt: string;
  readonly orcaContext: { readonly worktree: string | null; readonly project: string | null; readonly branch: string | null };
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

export function buildObservationRecord(id: string, tool: string, at: string): ObservationRecord {
  return { type: "observation", id, at, tool };
}

/** One JSONL line, newline-terminated, ready to append. */
export function serializeRecord(record: MeasurementRecord): string {
  return `${JSON.stringify(record)}\n`;
}
