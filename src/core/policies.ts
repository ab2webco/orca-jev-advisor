// Loads and validates a policies file: the JSON array of `{id, rule}` rows
// that decideDestination's policy stage judges coverage against.
//
// This is the same shape and the same validation that tools/decide.ts and
// tools/policy-gate.ts each used to carry as their own inline copy of
// `loadPolicies` -- moved here once, so both entry points (and the Orca
// plugin's config panel, when it needs to validate a pasted policies file)
// share one implementation instead of three.

import { readFile } from "node:fs/promises";
import type { Policy } from "./decisions.ts";
import { isRecord, isString } from "../guards.ts";

/** Reserved: never usable as a real policy id, since Jev's coverage question uses it to mean "none of these apply". */
export const NO_POLICY_ID = "sin_politica";

function isPolicyRow(value: unknown, index: number): Policy {
  if (!isRecord(value) || !isString(value.id) || !isString(value.rule)) {
    throw new Error(`La politica en la posicion ${index} necesita 'id' y 'rule' de texto`);
  }
  if (value.id === NO_POLICY_ID) {
    throw new Error(`'${NO_POLICY_ID}' es un id reservado y no puede usarse como id de politica`);
  }
  return { id: value.id, rule: value.rule };
}

/**
 * Reads a JSON file containing a non-empty array of `{id, rule}` rows.
 * Throws a descriptive Error on any structural problem -- there is no
 * silent fallback here, because a malformed policies file is a
 * misconfiguration the operator needs to see and fix, not something to
 * paper over with a default.
 */
export async function loadPolicies(path: string): Promise<Policy[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo leer o parsear el archivo de politicas en ${path}: ${message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`El archivo de politicas en ${path} debe ser un arreglo no vacio`);
  }
  return raw.map((row, index) => isPolicyRow(row, index));
}
