// Small hand-written type guards used to narrow `unknown` values coming
// from external sources (the Orca CLI, catalog.json, the Jev HTTP API) into
// declared types. No validation library is used on purpose: this project
// runs with zero dependencies, so every check is explicit and every
// mismatch throws a descriptive Error instead of silently becoming `any`.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value);
}

export function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

export function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}
