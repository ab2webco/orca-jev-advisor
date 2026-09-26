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

import { isRecord, isString } from "../guards.ts";
import type { ModSkillsReadiness } from "./mod_skills_readiness.ts";

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
  /**
   * Whether THIS decision actually replaced the engine's own listing with
   * an injected skill for this turn (JEVADV-4): true only once active mode
   * picked a name and its SKILL.md was read successfully. `listingChars`
   * above is the roster's real size regardless of outcome; this is the
   * field that tells "would have saved" (false) from "actually saved"
   * (true), so a turn that ended up delivering the full listing -- Jev
   * picked nothing, or the pick's SKILL.md failed to read -- is never
   * folded into "listing not sent" the way it silently was before this
   * field existed.
   */
  readonly listingWithheld: boolean;
  readonly wide: WideMeasurement | null;
  readonly fit: FitMeasurement | null;
  readonly decision: { readonly name: string | null; readonly reason: string };
  readonly latencyMs: { readonly wide: number | null; readonly fit: number | null };
  /**
   * The activation metric (src/core/mod_skills_readiness.ts) as it stood
   * when this decision was recorded, or null when it could not be
   * evaluated (no resolvable home, an unreadable log). Recorded for every
   * mode, not only `active` -- a panel can later ask "how many active runs
   * happened below readiness" without this module choosing which mode
   * matters. Never gates anything here: the switch stays the panel's own
   * UX (JEVADV-4's own scope), this is only for JEVADV-19/B8 to observe
   * the "active but silent / uncalibrated" state later.
   */
  readonly readiness: ModSkillsReadiness | null;
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
  readonly listingWithheld: boolean;
  readonly wide: WideMeasurement | null;
  readonly fit: FitMeasurement | null;
  readonly decision: { readonly name: string | null; readonly reason: string };
  readonly latencyMs: { readonly wide: number | null; readonly fit: number | null };
  readonly readiness: ModSkillsReadiness | null;
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

// ---------------------------------------------------------------------------
// Comparable-decision fold, for the readiness check above
// ---------------------------------------------------------------------------
//
// evaluateModSkillsReadiness (mod_skills_readiness.ts) takes two numbers --
// comparableCount, matchRate -- that only exist as a join between decision
// and observation rows across the WHOLE measurement log.
// adapters/orca/read-measurements.mjs's aggregateModSkills already does
// this join for the config panel, but it is a Node-only file (node:fs) and
// cannot be imported into the hooks sandbox ("no DOM, no Node") that needs
// the same numbers to stamp `readiness` above. This is that join's pure
// half, factored out here rather than duplicated ad hoc in
// hooks/runtime.ts, so a future pass could point the aggregator at it too
// instead of keeping two copies of the same fold.

export interface ComparableStats {
  readonly comparableCount: number;
  readonly matchRate: number | null;
}

function isComparableDecisionRow(value: unknown): value is { id: string; decision: { name: string | null } } {
  if (!isRecord(value) || value.type !== "decision" || value.mode !== "measurement") return false;
  if (!isString(value.id) || !isRecord(value.decision)) return false;
  const name = value.decision.name;
  return name === null || isString(name);
}

function isObservationRow(value: unknown): value is { id: string; skill: string } {
  return isRecord(value) && value.type === "observation" && isString(value.id) && isString(value.skill);
}

/**
 * Folds already-parsed JSONL rows (one measurement log, decisions and
 * observations mixed, in any order) into the two numbers readiness needs.
 * Mirrors aggregateModSkills' own join: a measurement-mode decision is
 * "comparable" only once an observation with the same `id` exists (the
 * model may never load a skill at all), and "matched" when the two agree.
 * Tolerant like the rest of this module's readers: a malformed or
 * unrelated row is skipped rather than thrown on.
 */
export function computeComparableStats(rows: readonly unknown[]): ComparableStats {
  const observedSkillById = new Map<string, string>();
  for (const row of rows) {
    if (isObservationRow(row)) observedSkillById.set(row.id, row.skill);
  }

  let comparable = 0;
  let matched = 0;
  for (const row of rows) {
    if (!isComparableDecisionRow(row)) continue;
    const observedSkill = observedSkillById.get(row.id);
    if (observedSkill === undefined) continue;
    comparable += 1;
    if (row.decision.name !== null && row.decision.name === observedSkill) matched += 1;
  }

  return { comparableCount: comparable, matchRate: comparable > 0 ? matched / comparable : null };
}
