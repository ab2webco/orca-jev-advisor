// Where Orca keeps the per-account Claude Code configuration its agent
// panes actually read.
//
// This exists because installing the gate into `~/.claude/settings.json`
// -- the obvious target, and the only one the installer had -- does NOT
// reach Claude Code running inside Orca. Measured on a real machine:
// every Orca pane is launched with
//
//   CLAUDE_CONFIG_DIR=<userData>/claude-accounts/<uuid>/auth
//
// so that directory, not the user's home, is Claude Code's whole config
// root there: its own settings.json, its own skills/. A hook written to
// the home settings.json is invisible to every pane, which is the one
// place a plugin shipped FOR Orca most needs it to work.
//
// Orca does sync some things into those accounts (the skills directory)
// but not hooks, and not completely -- on the machine this was measured
// on, one of four accounts was missing a skill the other three had. So
// the sync cannot be relied on: the installer writes to each account
// itself.
//
// Pure and platform-independent-of-the-running-OS, exactly like
// src/core/paths.ts: every function takes the target platform and the
// already-resolved home/environment as plain arguments, so all three
// platforms are testable from one machine. Listing the accounts needs the
// filesystem and therefore lives in the caller; `claudeAccountsDir` only
// says where to look.

import { posix, win32 } from "node:path";
import type { SupportedPlatform } from "./paths.ts";

/**
 * The environment variable Orca sets on its own processes, holding the
 * absolute path of its Electron `userData` directory. The plugin worker
 * inherits it, and so does every sidecar the worker spawns (main.mjs's
 * `sidecarEnv` copies `process.env`).
 *
 * Preferring this over a platform convention is not a style choice: a
 * machine can carry several Orca installations side by side (a release
 * `orca` and a development `orca-dev`, both with their own accounts), and
 * only this variable says which one is actually running the plugin.
 */
export const ORCA_USER_DATA_ENV = "ORCA_USER_DATA_PATH";

/** The Electron application name whose `userData` directory we fall back to when {@link ORCA_USER_DATA_ENV} is absent. */
const ORCA_APP_NAME = "orca";

export interface OrcaEnvironment {
  readonly home: string;
  /** Windows `%APPDATA%` (roaming), when known. */
  readonly appDataDir?: string;
  /** `$XDG_CONFIG_HOME`, when set. Linux only; ignored elsewhere. */
  readonly xdgConfigHome?: string;
  /** The raw value of {@link ORCA_USER_DATA_ENV}, when present. */
  readonly orcaUserDataPath?: string;
}

function joinerFor(platform: SupportedPlatform): (...parts: string[]) => string {
  return platform === "win32" ? win32.join : posix.join;
}

/**
 * Where Electron puts `userData` for an app named `orca`, per platform.
 * Only used when {@link ORCA_USER_DATA_ENV} is absent -- which happens when
 * the installer is run from a terminal rather than spawned by the worker.
 */
function conventionalUserDataDir(platform: SupportedPlatform, env: OrcaEnvironment): string {
  const join = joinerFor(platform);
  if (platform === "win32") {
    const base = env.appDataDir !== undefined && env.appDataDir.length > 0 ? env.appDataDir : join(env.home, "AppData", "Roaming");
    return join(base, ORCA_APP_NAME);
  }
  if (platform === "darwin") {
    return join(env.home, "Library", "Application Support", ORCA_APP_NAME);
  }
  const base = env.xdgConfigHome !== undefined && env.xdgConfigHome.length > 0 ? env.xdgConfigHome : join(env.home, ".config");
  return join(base, ORCA_APP_NAME);
}

export type UserDataSource = "environment" | "convention";

export interface ResolvedUserDataDir {
  readonly path: string;
  /**
   * How the path was arrived at. Worth reporting to the user: `convention`
   * is a guess that happens to be right on a standard install, while
   * `environment` is the running app stating its own location, and only
   * the latter picks the correct one out of several installations.
   */
  readonly source: UserDataSource;
}

export function resolveOrcaUserDataDir(platform: SupportedPlatform, env: OrcaEnvironment): ResolvedUserDataDir {
  const fromEnv = env.orcaUserDataPath;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { path: fromEnv.trim(), source: "environment" };
  }
  return { path: conventionalUserDataDir(platform, env), source: "convention" };
}

/** The directory holding one sub-directory per Claude account Orca manages. */
export function claudeAccountsDir(platform: SupportedPlatform, userDataDir: string): string {
  return joinerFor(platform)(userDataDir, "claude-accounts");
}

/**
 * Claude Code's config root for one account -- the value Orca puts in
 * `CLAUDE_CONFIG_DIR` for panes signed in as that account. Its
 * `settings.json` and `skills/` are the ones those panes read.
 */
export function accountConfigDir(platform: SupportedPlatform, accountsDir: string, accountId: string): string {
  return joinerFor(platform)(accountsDir, accountId, "auth");
}

export interface ClaudeConfigTarget {
  /** Stable key for install-state bookkeeping: `home`, or `account:<uuid>`. */
  readonly id: string;
  /** Short human-readable name for the panel and the doctor report. */
  readonly label: string;
  /** Claude Code's config root: the directory that holds settings.json and skills/. */
  readonly configDir: string;
  /** True for an Orca-managed account, false for the user's own `~/.claude`. */
  readonly orcaManaged: boolean;
}

export function homeConfigTarget(platform: SupportedPlatform, home: string): ClaudeConfigTarget {
  return {
    id: "home",
    label: "Claude Code outside Orca (~/.claude)",
    configDir: joinerFor(platform)(home, ".claude"),
    orcaManaged: false,
  };
}

export function accountConfigTarget(platform: SupportedPlatform, accountsDir: string, accountId: string): ClaudeConfigTarget {
  return {
    id: `account:${accountId}`,
    label: `Orca pane account ${accountId.slice(0, 8)}`,
    configDir: accountConfigDir(platform, accountsDir, accountId),
    orcaManaged: true,
  };
}

export function settingsPathFor(platform: SupportedPlatform, target: ClaudeConfigTarget): string {
  return joinerFor(platform)(target.configDir, "settings.json");
}

export function skillsDirFor(platform: SupportedPlatform, target: ClaudeConfigTarget): string {
  return joinerFor(platform)(target.configDir, "skills");
}
