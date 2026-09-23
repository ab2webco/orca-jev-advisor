// Typed client for Jev (TypeSafe): builds the five parallel questions from
// the projection plus the incoming encargo, posts them, validates the
// response, and returns a typed result. If no API key is passed in the
// network is never touched -- the exact payload that would have been sent
// is returned instead, so the caller can print it for a dry run.

import { isArrayOf, isNumber, isRecord, isString, isStringRecord } from "./guards.ts";
import type { Projection } from "./projection.ts";

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  // Measured against the real API: a string here returns HTTP 422
  // (model_attributes_type ... "Input should be a valid dictionary or
  // object"). It must be an object of named criteria, same shape as a
  // choice question's criteria.
  criteria?: Record<string, string>;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface JevRequest {
  state: JsonValue;
  model: "jev-latest";
  questions: Record<string, Question>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  // Measured live: the API returns this as an object mapping each level's
  // zero-based index (as a string key, e.g. "0", "1", ...) to its
  // description -- not a single string. `score` itself is a continuous
  // expectation over those indices (e.g. 2.85 on a 5-level 0..4 scale).
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Question ids (plain string literals: enums are not erasable TypeScript
// syntax, so Node's native type stripping cannot run them).
// ---------------------------------------------------------------------------

export const QUESTION_ID = {
  encargoType: "encargoType",
  destination: "destination",
  targetAgent: "targetAgent",
  delicateness: "delicateness",
  unambiguousDestination: "unambiguousDestination",
} as const;

export type QuestionId = (typeof QUESTION_ID)[keyof typeof QUESTION_ID];

export const NO_DESTINATION_MATCHES = "ninguna_coincide";
export const NO_AGENT_AVAILABLE = "ninguno_disponible";

// The delicateness scale. Its length is the single source of truth for how
// many levels a destination's `maxAutoDelicateness` (catalog.ts) can range
// over -- exported so catalog.ts can validate against it without the two
// modules drifting apart.
const DELICATENESS_CRITERIA = [
  "Trivial, sin riesgo real (consulta informativa)",
  "Riesgo bajo, fácilmente reversible",
  "Riesgo moderado, afecta a usuarios pero es recuperable",
  "Riesgo alto, toca producción o datos sensibles",
  "Crítico: riesgo legal, de seguridad o de pérdida de datos",
];

export const DELICATENESS_LEVELS = DELICATENESS_CRITERIA.length;

function projectionToJson(projection: Projection): JsonValue {
  return {
    generatedAt: projection.generatedAt,
    // Sibling note field, kept next to the excerpts it describes: measured
    // live with a prompt-injection payload planted inside an excerpt (see
    // odd/tasks/supervisor-enrutador.md) and Jev ignored it. This note plus
    // the quoting done in projection.ts (quoteUntrustedExcerpt) are both
    // required for that to keep holding -- do not drop either one.
    notaSobreCitas: projection.excerptDisclaimer,
    destinos: projection.destinations.map((d) => ({
      id: d.id,
      etiqueta: d.label,
      tipo: d.kind,
      tieneAgenteEnVivo: d.handle !== null,
      estadoAgente: d.agentState,
      tipoAgente: d.agentType,
      minutosDesdeUltimaSalida: d.minutesSinceLastOutput,
      conectado: d.connected,
      escribible: d.writable,
      ultimoMensajeDelAgente: d.lastAssistantExcerpt,
      vistaPreviaTerminal: d.terminalPreviewExcerpt,
    })),
  };
}

/**
 * Builds the Jev request: a small projection plus the incoming encargo, and
 * five parallel, isolated questions (they are all evaluated against the
 * same state, independently of each other). Nothing here asks Jev to
 * count, compare dates, or resolve which handle belongs to which
 * destination -- that is precomputed in projection.ts.
 */
export function buildJevRequest(encargo: string, projection: Projection): JevRequest {
  const destinationCriteria: Record<string, string> = {};
  for (const d of projection.destinations) {
    destinationCriteria[d.id] = `${d.label} (tipo: ${d.kind})`;
  }
  destinationCriteria[NO_DESTINATION_MATCHES] = "El encargo no corresponde a ninguno de los destinos listados";

  const agentCriteria: Record<string, string> = {};
  for (const d of projection.destinations) {
    if (d.handle === null) continue;
    agentCriteria[d.id] = `Agente en vivo de ${d.label} (estado: ${d.agentState ?? "desconocido"})`;
  }
  agentCriteria[NO_AGENT_AVAILABLE] = "Ningún agente en vivo es el destinatario adecuado ahora mismo";

  const questions: Record<string, Question> = {
    [QUESTION_ID.encargoType]: {
      type: "choice",
      instructions: "Clasifica el tipo de encargo entrante para un supervisor multi-proyecto que enruta a terminales de agentes.",
      criteria: {
        incidente_tecnico: "Una falla o interrupción de un servicio o bot que ya está en producción",
        cambio_sitio_cliente: "Una solicitud de cambio sobre el sitio o producto de un cliente",
        agente_bloqueado: "Un agente o proceso automatizado quedó bloqueado y necesita intervención",
        consulta_soporte: "Una pregunta o mensaje de soporte que no describe una falla técnica",
        otro: "Ninguna de las anteriores describe bien el encargo",
      },
    },
    [QUESTION_ID.destination]: {
      type: "choice",
      instructions: "Con base en el encargo y el estado de cada destino, decide a qué destino del catálogo pertenece este encargo.",
      criteria: destinationCriteria,
    },
    [QUESTION_ID.targetAgent]: {
      type: "choice",
      instructions:
        "De los agentes en vivo disponibles, decide cuál debería recibir este encargo. Si el destino correcto no tiene un agente en vivo disponible, elige la opción de que ninguno está disponible.",
      criteria: agentCriteria,
    },
    [QUESTION_ID.delicateness]: {
      type: "score",
      instructions: "Evalúa qué tan delicado es este encargo si se actúa sobre él sin supervisión humana directa.",
      criteria: DELICATENESS_CRITERIA,
    },
    // Measured live: a compound question mixing ambiguity, reversibility
    // and external impact ("es seguro y apropiado actuar...") scored
    // 0.19-0.44 on every case, clear and ambiguous alike -- it never
    // separated anything. This atomic question, asking ONLY about whether
    // the encargo names a single unambiguous destination, separated
    // cleanly (0.78-0.82 on clear cases, 0.09-0.43 on ambiguous ones) and a
    // 0.6 gate on it was right 6/6. Do not fold risk/reversibility back
    // into this question -- that axis is `delicateness`, composed in code
    // (see decide.ts).
    [QUESTION_ID.unambiguousDestination]: {
      type: "noul",
      instructions:
        "El encargo identifica sin ambiguedad un unico destino de la lista. " +
        "Esta pregunta es solo sobre la claridad del encargo, no sobre el riesgo de ejecutarlo.",
      criteria: {
        un_solo_destino: "Solo un destino de la lista puede corresponder a lo que pide el encargo.",
        sin_suposiciones: "No hace falta suponer nada que el encargo no diga para elegir ese destino.",
      },
    },
  };

  return {
    state: {
      encargo,
      proyeccion: projectionToJson(projection),
    },
    model: "jev-latest",
    questions,
  };
}

// ---------------------------------------------------------------------------
// Network call
// ---------------------------------------------------------------------------

export type JevResult = { kind: "dry"; request: JevRequest } | { kind: "answered"; request: JevRequest; response: JevResponse };

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RETRYABLE_STATUS = new Set([429, 529]);
const MAX_RETRIES = 1;

function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
  if (!isRecord(value) || value.type !== "choice") return false;
  return isString(value.choice) && isRecord(value.probabilities) && isNumber(value.confidence);
}

function isScoreAnswer(value: unknown): value is ScoreAnswer {
  if (!isRecord(value) || value.type !== "score") return false;
  return isNumber(value.score) && isStringRecord(value.legend) && isRecord(value.probabilities) && isNumber(value.confidence);
}

function isNoulAnswer(value: unknown): value is NoulAnswer {
  if (!isRecord(value) || value.type !== "noul") return false;
  return isNumber(value.noul);
}

function isAnswer(value: unknown): value is Answer {
  return isChoiceAnswer(value) || isScoreAnswer(value) || isNoulAnswer(value);
}

function isJevResponse(value: unknown): value is JevResponse {
  if (!isRecord(value)) return false;
  if (!isString(value.model)) return false;
  if (!isRecord(value.answers)) return false;
  for (const answer of Object.values(value.answers)) {
    if (!isAnswer(answer)) return false;
  }
  if (!isRecord(value.usage)) return false;
  return isNumber(value.usage.input_tokens) && isNumber(value.usage.output_tokens);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Sends the built request to Jev. `apiKey` is resolved by the caller (see
 * src/core/secrets.ts) and passed in explicitly -- this module never reads env vars
 * or files itself. If `apiKey` is null or blank, the network is never
 * touched: the exact payload that would have been sent is returned as a
 * "dry" result instead. Retries once, with backoff, only on 429 (rate
 * limited) or 529 (overloaded); any other non-ok status throws
 * immediately. The key itself is never logged and never appears in any
 * thrown error message.
 */
export async function askJev(request: JevRequest, apiKey: string | null): Promise<JevResult> {
  if (apiKey === null || apiKey.trim().length === 0) {
    return { kind: "dry", request };
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw new Error(`Could not contact Jev: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.ok) {
      const parsed: unknown = await response.json();
      if (!isJevResponse(parsed)) {
        throw new Error("Jev responded 200 but the body does not have the expected shape {model, answers, usage}");
      }
      return { kind: "answered", request, response: parsed };
    }

    const bodyText = await response.text().catch(() => "");
    lastError = new Error(`Jev responded ${response.status}: ${bodyText || response.statusText}`);

    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_RETRIES) {
      throw lastError;
    }
    await sleep(500 * 2 ** attempt);
  }

  throw lastError ?? new Error("Jev: unknown failure after retries");
}
