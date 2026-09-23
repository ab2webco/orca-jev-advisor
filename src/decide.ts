// Pure mapping from Jev's answers + the destination's autonomy thresholds
// to a routing decision. No I/O happens here: given the same inputs this
// always returns the same decision, which is what makes it testable and
// auditable independently of the network call and the terminal actions.
//
// The model supplies one judgment per axis; composing them into a decision
// is code, not the model:
//   - `unambiguousDestination` (noul): how clearly the encargo names a
//     single destination. Gated against confirmThreshold/actThreshold.
//   - `delicateness` (score): how risky it would be to act without a
//     human. Gated against the destination's maxAutoDelicateness,
//     independently of how unambiguous the encargo was.
//   - `canReceiveInput` (code, from the live projection): whether there is
//     a resolved, connected, non-busy terminal to send to.
//
// This split replaced a single compound "may I act without asking"
// question that measured 0.19-0.44 on every real case (clear and
// ambiguous alike) because it silently mixed ambiguity, reversibility and
// external impact into one number and therefore never separated anything.

import type { Catalog, Destination } from "./core/catalog.ts";
import type { Answer, ChoiceAnswer, JevResponse, NoulAnswer, ScoreAnswer } from "./jev.ts";
import { QUESTION_ID } from "./jev.ts";
import type { DestinationProjection, Projection } from "./projection.ts";

export type Action = "act" | "confirm" | "ask-human";

export interface Decision {
  action: Action;
  destinationId: string | null;
  handle: string | null;
  instruction: string | null;
  reason: string;
  ambiguityNoul: number | null;
  delicatenessScore: number | null;
}

// Agent states considered able to receive a fresh instruction right now.
// "working" is deliberately excluded: the agent is busy, and sending text
// into a busy composer risks interrupting or corrupting an in-flight task.
const RECEIVABLE_STATES = new Set<string>(["done", "waiting", "blocked"]);

function asChoice(answer: Answer | undefined): ChoiceAnswer | null {
  return answer !== undefined && answer.type === "choice" ? answer : null;
}

function asScore(answer: Answer | undefined): ScoreAnswer | null {
  return answer !== undefined && answer.type === "score" ? answer : null;
}

function asNoul(answer: Answer | undefined): NoulAnswer | null {
  return answer !== undefined && answer.type === "noul" ? answer : null;
}

function findDestination(catalog: Catalog, id: string): Destination | null {
  return catalog.destinations.find((d) => d.id === id) ?? null;
}

function findProjectionEntry(projection: Projection, id: string): DestinationProjection | null {
  return projection.destinations.find((d) => d.id === id) ?? null;
}

// `score` is a continuous expectation over the legend's zero-based indices
// (e.g. 2.85 on a 5-level 0..4 scale); pick the description of whichever
// indexed level sits closest to it for a human-readable reason string.
function describeDelicateness(score: number, legend: Record<string, string>): string {
  const entries = Object.entries(legend);
  if (entries.length === 0) return `puntaje ${score.toFixed(2)} (sin leyenda)`;
  let closest = entries[0];
  let closestDistance = Math.abs(Number(closest[0]) - score);
  for (const entry of entries) {
    const distance = Math.abs(Number(entry[0]) - score);
    if (distance < closestDistance) {
      closest = entry;
      closestDistance = distance;
    }
  }
  return closest[1];
}

// Kept exactly as-is per instruction: this logic is correct.
function canReceiveInput(entry: DestinationProjection): boolean {
  return entry.handle !== null && entry.agentState !== null && RECEIVABLE_STATES.has(entry.agentState) && entry.connected === true;
}

function incomplete(reason: string): Decision {
  return { action: "ask-human", destinationId: null, handle: null, instruction: null, reason, ambiguityNoul: null, delicatenessScore: null };
}

/**
 * Composes the routing decision from the model's per-axis judgments and
 * the destination's autonomy thresholds. Three gates are evaluated
 * independently (a failing case can cite more than one):
 *   - handle: ask-human when there is no receivable handle.
 *   - delicateness: ask-human, regardless of ambiguityNoul, when
 *     delicatenessScore exceeds the destination's maxAutoDelicateness.
 *   - ambiguity: ask-human when ambiguityNoul is below confirmThreshold.
 * If all three gates pass: confirm when ambiguityNoul is between
 * confirmThreshold and actThreshold; act only at or above actThreshold.
 */
export function decide(encargo: string, response: JevResponse, catalog: Catalog, projection: Projection): Decision {
  const destinationAnswer = asChoice(response.answers[QUESTION_ID.destination]);
  const targetAgentAnswer = asChoice(response.answers[QUESTION_ID.targetAgent]);
  const delicatenessAnswer = asScore(response.answers[QUESTION_ID.delicateness]);
  const ambiguityAnswer = asNoul(response.answers[QUESTION_ID.unambiguousDestination]);

  if (destinationAnswer === null || delicatenessAnswer === null || ambiguityAnswer === null) {
    return incomplete("Jev no devolvió respuestas completas para 'destination', 'delicateness' o 'unambiguousDestination'.");
  }

  const destinationId = destinationAnswer.choice;
  const destination = findDestination(catalog, destinationId);
  const projectionEntry = findProjectionEntry(projection, destinationId);

  if (destination === null || projectionEntry === null) {
    return incomplete(`Jev no identificó un destino conocido del catálogo (respuesta: '${destinationId}').`);
  }

  // targetAgent may point at a different destination than `destination`
  // (e.g. the encargo is about X, but X has no live agent right now, so
  // Jev suggests the closest live sibling). Prefer targetAgent's handle
  // only when it names a real, live destination from our own
  // catalog/projection; otherwise fall back to destination's own entry.
  const targetAgentId = targetAgentAnswer?.choice ?? null;
  const targetAgentEntry = targetAgentId !== null ? findProjectionEntry(projection, targetAgentId) : null;
  const agentEntry = targetAgentEntry ?? projectionEntry;

  const ambiguityNoul = ambiguityAnswer.noul;
  const delicatenessScore = delicatenessAnswer.score;
  const { actThreshold, confirmThreshold, maxAutoDelicateness } = destination.autonomy;

  const reasonParts = [
    `Destino: ${destination.label} (${destination.id}).`,
    `Claridad del encargo (unambiguousDestination): ${ambiguityNoul.toFixed(2)} (umbral confirmar ${confirmThreshold}, actuar ${actThreshold}).`,
    `Delicadeza: ${delicatenessScore.toFixed(2)} - ${describeDelicateness(delicatenessScore, delicatenessAnswer.legend)} (máximo nivel permitido para actuar solo: ${maxAutoDelicateness}).`,
  ];

  const makeDecision = (action: Action, reason: string, includeInstruction: boolean): Decision => ({
    action,
    destinationId: destination.id,
    handle: agentEntry.handle,
    instruction: includeInstruction ? encargo : null,
    reason: [...reasonParts, reason].join(" "),
    ambiguityNoul,
    delicatenessScore,
  });

  // Evaluate all three gates independently -- each axis is checked and
  // reported on its own, so a case that fails on more than one axis (e.g.
  // both a busy handle AND an ambiguous encargo) says so instead of hiding
  // the second problem behind the first.
  const blockingReasons: string[] = [];

  const handleOk = canReceiveInput(agentEntry);
  if (!handleOk) {
    blockingReasons.push(
      agentEntry.handle === null
        ? "Eje bloqueante: handle. No hay una terminal en vivo resuelta para este destino."
        : `Eje bloqueante: handle. El agente/terminal no está en condición de recibir una instrucción ahora (estado: '${agentEntry.agentState ?? "desconocido"}', conectado: ${agentEntry.connected ?? false}).`,
    );
  }

  // Delicateness axis -- unconditional, regardless of ambiguityNoul.
  const delicatenessOk = delicatenessScore <= maxAutoDelicateness;
  if (!delicatenessOk) {
    blockingReasons.push(
      `Eje bloqueante: delicadeza. ${delicatenessScore.toFixed(2)} supera el máximo de ${maxAutoDelicateness} permitido para actuar sin humano en este destino.`,
    );
  }

  // Ambiguity axis -- the confirmThreshold floor, independent of delicateness.
  const clearEnoughToConfirm = ambiguityNoul >= confirmThreshold;
  if (!clearEnoughToConfirm) {
    blockingReasons.push(
      `Eje bloqueante: ambigüedad. ${ambiguityNoul.toFixed(2)} está por debajo del umbral de confirmación (${confirmThreshold}).`,
    );
  }

  if (blockingReasons.length > 0) {
    return makeDecision("ask-human", blockingReasons.join(" "), false);
  }

  // All three gates pass: handle is receivable, delicateness is within the
  // destination's ceiling, and ambiguityNoul clears at least confirmThreshold.
  if (ambiguityNoul < actThreshold) {
    return makeDecision(
      "confirm",
      `En banda de confirmación: claridad ${ambiguityNoul.toFixed(2)} está entre confirmar (${confirmThreshold}) y actuar (${actThreshold}); delicadeza y handle ya están dentro de lo permitido.`,
      true,
    );
  }

  return makeDecision("act", "Los tres ejes (handle, delicadeza, ambigüedad) permiten actuar sin humano.", true);
}
