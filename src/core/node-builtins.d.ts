// Minimal ambient declarations for the Node built-ins this tsconfig's files
// import, so `npx typescript@latest --noEmit` can typecheck them without
// pulling in @types/node -- consistent with this codebase's zero-dependency,
// hand-rolled-types approach (see ../guards.ts, which hand-writes its own
// runtime guards instead of reaching for a validation library).
//
// This is NOT a general Node.js typings shim: it only covers the exact
// surface actually used by policies.ts. Widen it if a future file in
// tsconfig.decisions.json's scope needs more of `node:fs/promises`.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}
