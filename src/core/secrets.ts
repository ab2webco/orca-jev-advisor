// Resolves the TypeSafe API key for both runtime contexts this codebase
// supports: running inside the Orca plugin worker (where the key lives in
// the host's `secrets` store) and running as a plain CLI tool/hook on this
// machine (where it lives in the environment or a dev-only file).
//
// Precedence, documented once, here, so nothing else has to guess it:
//
//   1. The plugin's `secrets` store, via `secrets.get` -- ONLY when a
//      SecretsHost is passed in (i.e. this code is running inside the
//      plugin worker). This is the only path a real deployment should
//      rely on.
//   2. The `TYPESAFE_API_KEY` environment variable -- for CLI/hook use.
//   3. `~/.config/orca-supervisor/env`, a single `KEY=value` line -- a
//      development-only plaintext fallback for CLI/hook use when the
//      environment variable is inconvenient to set (e.g. a hook spawned
//      by an editor that doesn't inherit the shell's env).
//
// This module never shells out, never logs the resolved key, and never
// includes it in an error message or exception -- a failed lookup simply
// returns null, which every caller treats as "no key configured".

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePlatform, resolveConfigDir } from "./paths.ts";

const ENV_VAR_NAME = "TYPESAFE_API_KEY";
// `os.homedir()` already resolves HOME vs USERPROFILE correctly per
// platform; resolveConfigDir only decides the `.config`/`%APPDATA%`/XDG
// convention on top of it.
const FALLBACK_PATH = join(
  resolveConfigDir(normalizePlatform(process.platform), {
    home: homedir(),
    appDataDir: process.env.APPDATA,
    localAppDataDir: process.env.LOCALAPPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  }),
  "env",
);

/** The key name this plugin uses inside Orca's `secrets` store. */
export const SECRET_KEY_NAME = "typesafeApiKey";

/** The subset of the host's `secrets` capability this module needs. */
export interface SecretsHost {
  get(key: string): Promise<string | null>;
}

function stripMatchingQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}

/** Parses a minimal `KEY=value` line format; ignores blank lines and `#` comments. */
function parseEnvFile(content: string): string | null {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (key !== ENV_VAR_NAME) continue;

    const value = stripMatchingQuotes(line.slice(separatorIndex + 1).trim());
    return value.length > 0 ? value : null;
  }
  return null;
}

async function fromFallbackFile(): Promise<string | null> {
  let fileContent: string;
  try {
    fileContent = await readFile(FALLBACK_PATH, "utf8");
  } catch {
    return null;
  }
  return parseEnvFile(fileContent);
}

/**
 * Resolves the TypeSafe API key using the precedence documented above.
 * `secretsHost` is optional and should only be supplied when running
 * inside the plugin worker (where `host.secrets` implements it); CLI
 * entry points and hooks call this with no argument and fall through to
 * the environment variable / dev file.
 */
export async function resolveApiKey(secretsHost?: SecretsHost): Promise<string | null> {
  if (secretsHost !== undefined) {
    let fromSecrets: string | null = null;
    try {
      fromSecrets = await secretsHost.get(SECRET_KEY_NAME);
    } catch {
      fromSecrets = null;
    }
    if (fromSecrets !== null && fromSecrets.trim().length > 0) {
      return fromSecrets.trim();
    }
  }

  const fromEnv = process.env[ENV_VAR_NAME];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  return fromFallbackFile();
}
