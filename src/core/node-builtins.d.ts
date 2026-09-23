// Minimal ambient declarations for the Node built-ins this tsconfig's files
// import, so `npx typescript@latest --noEmit` can typecheck them without
// pulling in @types/node -- consistent with this codebase's zero-dependency,
// hand-rolled-types approach (see ../guards.ts, which hand-writes its own
// runtime guards instead of reaching for a validation library).
//
// This is NOT a general Node.js typings shim: it only covers the exact
// surface actually used by the files that include it (policies.ts,
// paths.ts, secrets.ts, gate-bash.ts). Widen it further if a future file
// needs more of any of these modules.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export const posix: { join(...paths: string[]): string };
  export const win32: { join(...paths: string[]): string };
}

declare module "node:child_process" {
  export function execFileSync(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      encoding?: string;
      stdio?: readonly ["ignore" | "pipe", "ignore" | "pipe", "ignore" | "pipe"];
    },
  ): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: string): string };
  };
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
  export function appendFileSync(path: string, data: string, encoding?: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

// `process` is a Node global, not a module import -- declared ambiently so
// files that reference `process.cwd()`, `process.env`, `process.exit()`,
// `process.stdout.write()` and `process.platform` typecheck without
// @types/node.
declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  stdout: { write(chunk: string): boolean };
  platform: string;
};
