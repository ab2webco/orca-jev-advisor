// Loads and validates a policies file: the JSON array of `{id, rule}` rows
// that decideDestination's policy stage judges coverage against.
//
// This is the same shape and the same validation that tools/decide.ts and
// tools/policy-gate.ts each used to carry as their own inline copy of
// `loadPolicies` -- moved here once, so both entry points (and the Orca
// plugin's config panel, when it needs to validate a pasted policies file)
// share one implementation instead of three.

import { readFile } from "node:fs/promises";
import type { Policy, PolicyKind } from "./decisions.ts";
import { isPolicyScope, POLICY_SCOPE_VALUES } from "./decisions.ts";
import { isRecord, isString } from "../guards.ts";

/** Reserved: never usable as a real policy id, since Jev's coverage question uses it to mean "none of these apply". */
export const NO_POLICY_ID = "no_policy";

/** The only valid values for a policy row's `kind` -- see PolicyKind in decisions.ts. */
const POLICY_KINDS: readonly PolicyKind[] = ["permits", "requires_human", "prohibits"];

function isPolicyKind(value: unknown): value is PolicyKind {
  return isString(value) && (POLICY_KINDS as readonly string[]).includes(value);
}

// The only valid values for a policy row's optional `scope` -- see
// isPolicyScope in decisions.ts, the one runtime member list every reader
// shares (odd/tasks/release-0.5.1.md JEVADV-36) instead of its own copy.

function isPolicyRow(value: unknown, index: number): Policy {
  if (!isRecord(value) || !isString(value.id) || !isString(value.rule)) {
    throw new Error(`La politica en la posicion ${index} necesita 'id' y 'rule' de texto`);
  }
  if (value.id === NO_POLICY_ID) {
    throw new Error(`'${NO_POLICY_ID}' es un id reservado y no puede usarse como id de politica`);
  }
  // No silent fallback here, on purpose: a policy with no `kind` (or a
  // typo'd one) used to mean every low-confidence match against it was
  // treated as a violation, regardless of what the rule actually said. A
  // missing/invalid `kind` is a misconfiguration the operator needs to see
  // and fix, exactly like a missing `id` or `rule`.
  if (!isPolicyKind(value.kind)) {
    throw new Error(`La politica en la posicion ${index} ('${value.id}') necesita 'kind' igual a uno de: ${POLICY_KINDS.join(", ")}`);
  }
  // Unlike `kind`, `scope` is genuinely optional: absent means "resolve it
  // later" (resolvePolicyScope in decisions.ts), not a misconfiguration --
  // but a PRESENT, invalid value is still a typo the operator needs to see,
  // same discipline as `kind` above.
  if ("scope" in value && value.scope !== undefined && !isPolicyScope(value.scope)) {
    // JEVADV-37 (R2-002, odd/tasks/release-0.5.1.md): the allowed values are
    // named from POLICY_SCOPE_VALUES (decisions.ts), the single runtime list
    // isPolicyScope itself already checks against, rather than a second,
    // hardcoded copy of the same three strings drifting out of sync with it.
    throw new Error(`La politica en la posicion ${index} ('${value.id}') tiene un 'scope' invalido; debe ser uno de: ${[...POLICY_SCOPE_VALUES].join(", ")}`);
  }
  return {
    id: value.id,
    rule: value.rule,
    kind: value.kind,
    ...(isPolicyScope(value.scope) ? { scope: value.scope } : {}),
  };
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
