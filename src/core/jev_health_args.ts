// 0.6.22 T2 (JEVADV-97): the arguments of `npm run jev-health -- <command>`.
// Hand-rolled, like ab_benchmark_cli.ts (this plugin ships with no dependencies).

export type JevHealthArgs =
  | { readonly command: "usage"; readonly days: number }
  | { readonly command: "help" }
  | { readonly command: "error"; readonly message: string };

export const DEFAULT_USAGE_DAYS = 7;

function flagValue(argv: readonly string[], flag: string): { readonly present: boolean; readonly value: string | null } {
  const index = argv.indexOf(flag);
  if (index === -1) return { present: false, value: null };
  const value = argv[index + 1];
  return { present: true, value: value !== undefined && !value.startsWith("--") ? value : null };
}

function positiveInteger(raw: string | null): number | null {
  return raw !== null && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

export function parseJevHealthArgs(argv: readonly string[]): JevHealthArgs {
  const [command, ...rest] = argv;
  if (command === "usage") {
    const days = flagValue(rest, "--days");
    if (!days.present) return { command: "usage", days: DEFAULT_USAGE_DAYS };
    const parsed = positiveInteger(days.value);
    return parsed === null ? { command: "error", message: "--days needs a positive whole number" } : { command: "usage", days: parsed };
  }
  return { command: "help" };
}
