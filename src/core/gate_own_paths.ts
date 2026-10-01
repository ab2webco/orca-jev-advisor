// 0.6.17 T2 (JEVADV-90): which files the gate and the model router decide
// from, as absolute paths, and whether a path is one of them. Kept apart
// from gate_own_files.ts (which reads a command line) so the file tools'
// guard, run on every edit, loads nothing but this. Pure: no I/O;
// `canonical` is how the caller resolves a symlink.
import { basename, dirname, join, normalize } from "node:path";
import { PLUGIN_ID } from "./orca_enablement.ts";

export const identity = (path: string): string => path;

/** The plugin config directory's files the gate or the router read to decide (see odd/tasks/release-0.6.17.md T2 for each read site). */
export const GATE_OWN_CONFIG_FILES: readonly string[] = [
  "catalog.json",
  "policies.json",
  "team-owners.json",
  "queue-mode.json",
  "deny-tier-config.json",
  "ab-benchmark-config.json",
  "models-catalog.json",
  "explicit-models.json",
  "quota.json",
  "mod-skills-config.json",
  "mod-skills-sampling-config.json",
  "env",
];

/** The cache directory's files the gate reads back as a verdict or a pass. */
export const GATE_OWN_CACHE_FILES: readonly string[] = ["gate-bash.json", "gate-advice-retry.json", "gate-enablement.json", "agent-model-enablement.json", "human-queue.jsonl"];

/**
 * The plugin's own Orca storage, `<Orca user data>/plugins-data/<plugin id>/`
 * (0.6.18 T3, JEVADV-94). The gate never reads it, but the panel and the
 * worker rewrite every config mirror above from `storage.json`, and the key
 * mirror (`env`) from `secrets.json.enc`, so a write there reaches the gate at
 * the next refresh.
 */
export const GATE_OWN_ORCA_STORAGE_FILES: readonly string[] = ["storage.json", "secrets.json.enc"];

export interface GateOwnFiles {
  readonly files: ReadonlySet<string>;
  /** Directories whose removal or move takes the files with them. */
  readonly roots: readonly string[];
  /** Orca's user data directory (each spelling): its profile index and each profile's `orca-data.json` say whether the plugin runs at all. */
  readonly orcaUserDataDirs: readonly string[];
}

/**
 * The protected set for these directories, each also under its `canonical`
 * spelling (a symlinked home or temp directory: macOS's `/var` is
 * `/private/var`), so a target resolved through `canonical` still matches.
 */
export function gateOwnFiles(input: { readonly configDir: string; readonly cacheDir: string; readonly orcaUserDataDir: string | null }, canonical: (path: string) => string = identity): GateOwnFiles {
  const spellings = (dir: string): readonly string[] => [...new Set([normalize(dir), normalize(canonical(dir))])];
  const configDirs = spellings(input.configDir);
  const cacheDirs = spellings(input.cacheDir);
  const files = new Set<string>([
    ...configDirs.flatMap((dir) => GATE_OWN_CONFIG_FILES.map((name) => join(dir, name))),
    ...cacheDirs.flatMap((dir) => GATE_OWN_CACHE_FILES.map((name) => join(dir, name))),
  ]);
  const orcaDirs = input.orcaUserDataDir === null ? [] : spellings(input.orcaUserDataDir);
  const storageDirs = orcaDirs.map((dir) => join(dir, "plugins-data", PLUGIN_ID));
  for (const dir of orcaDirs) files.add(join(dir, "orca-profile-index.json"));
  for (const dir of storageDirs) for (const name of GATE_OWN_ORCA_STORAGE_FILES) files.add(join(dir, name));
  return { files, roots: [...configDirs, ...cacheDirs, ...storageDirs], orcaUserDataDirs: orcaDirs };
}

function ownFile(path: string, own: GateOwnFiles): string | null {
  if (own.files.has(path)) return path;
  if (basename(path) === "orca-data.json" && own.orcaUserDataDirs.some((orca) => dirname(dirname(path)) === join(orca, "profiles"))) return path;
  return null;
}

/** The protected file `path` is (itself or through `canonical`), or null. `path` must be absolute. */
export function gateOwnFileAt(path: string, own: GateOwnFiles, canonical: (path: string) => string = identity): string | null {
  const lexical = normalize(path);
  return ownFile(lexical, own) ?? ownFile(normalize(canonical(lexical)), own);
}
