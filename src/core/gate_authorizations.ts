// The gate's remembered delivery authorizations (0.6.28). When the agent
// re-runs an advised delivery line unchanged (the advice-retry pass), the
// line's delivery classes (delivery_class.ts) are remembered for the
// repository; a later risk advice on a line made only of authorized classes
// becomes an allow. The repository is its normalized origin URL, so every
// worktree and clone of one repository shares it; an authorization expires
// 30 days after its last use.
//
// Pure: the store is a plain value, every function returns a new one, and the
// adapter (adapters/claude/gate-bash.ts) reads and writes the file.

import { DELIVERY_CLASSES } from "./delivery_class.ts";
import type { DeliveryClass } from "./delivery_class.ts";

export const AUTHORIZATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** One remembered class: when it was first confirmed, last used, and how often. */
export interface AuthorizationUse {
  readonly firstAt: string;
  readonly lastAt: string;
  readonly uses: number;
}

export type RepoAuthorizations = Readonly<Partial<Record<DeliveryClass, AuthorizationUse>>>;

export interface AuthorizationStore {
  readonly version: 1;
  readonly repos: Readonly<Record<string, RepoAuthorizations>>;
}

export const EMPTY_AUTHORIZATIONS: AuthorizationStore = { version: 1, repos: {} };

/**
 * `host/owner/repo`, lowercase and without `.git`, for an https, ssh or
 * scp-like (`git@host:owner/repo`) remote URL, credentials and port dropped.
 * Without a remote that names a host (none, a local path, `file://`), the
 * repository root as `path:<root>`; null when neither is known.
 */
export function repoIdentity(remoteUrl: string | null, repoRoot: string | null): string | null {
  const url = (remoteUrl ?? "").trim();
  const fromUrl = identityFromUrl(url);
  if (fromUrl !== null) return fromUrl;
  const root = (repoRoot ?? "").trim();
  return root.length > 0 ? `path:${root}` : null;
}

function identityFromUrl(url: string): string | null {
  let host: string;
  let path: string;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(url);
  if (scheme !== null) {
    if ((scheme[1] ?? "").toLowerCase() === "file") return null;
    host = (scheme[2] ?? "").replace(/^.*@/, "").replace(/:\d*$/, "");
    path = scheme[3] ?? "";
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(url);
    if (scp === null) return null;
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  }
  const cleanPath = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (host.length === 0 || cleanPath.length === 0) return null;
  return `${host}/${cleanPath}`.toLowerCase();
}

function isDeliveryClass(value: string): value is DeliveryClass {
  return (DELIVERY_CLASSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUse(value: unknown): AuthorizationUse | null {
  if (!isRecord(value)) return null;
  const { firstAt, lastAt, uses } = value;
  if (typeof firstAt !== "string" || typeof lastAt !== "string" || typeof uses !== "number") return null;
  if (Number.isNaN(Date.parse(firstAt)) || Number.isNaN(Date.parse(lastAt)) || !Number.isFinite(uses)) return null;
  return { firstAt, lastAt, uses };
}

/** The store read from the file's JSON; anything malformed is dropped, and nothing throws. */
export function parseAuthorizations(raw: unknown): AuthorizationStore {
  if (!isRecord(raw) || raw["version"] !== 1 || !isRecord(raw["repos"])) return EMPTY_AUTHORIZATIONS;
  const repos: Record<string, RepoAuthorizations> = {};
  for (const [repo, entry] of Object.entries(raw["repos"])) {
    if (!isRecord(entry)) continue;
    const classes: Partial<Record<DeliveryClass, AuthorizationUse>> = {};
    for (const [cls, use] of Object.entries(entry)) {
      const parsed = parseUse(use);
      if (isDeliveryClass(cls) && parsed !== null) classes[cls] = parsed;
    }
    if (Object.keys(classes).length > 0) repos[repo] = classes;
  }
  return { version: 1, repos };
}

function withRepo(store: AuthorizationStore, repo: string, classes: RepoAuthorizations): AuthorizationStore {
  const repos: Record<string, RepoAuthorizations> = { ...store.repos };
  if (Object.keys(classes).length === 0) delete repos[repo];
  else repos[repo] = classes;
  return { version: 1, repos };
}

/** Remembers `classes` for `repo` as confirmed at `nowIso`: new ones start, existing ones count one more use. */
export function recordAuthorization(store: AuthorizationStore, repo: string, classes: readonly DeliveryClass[], nowIso: string): AuthorizationStore {
  const current: Partial<Record<DeliveryClass, AuthorizationUse>> = { ...store.repos[repo] };
  for (const cls of classes) {
    const use = current[cls];
    current[cls] = use === undefined ? { firstAt: nowIso, lastAt: nowIso, uses: 1 } : { firstAt: use.firstAt, lastAt: nowIso, uses: use.uses + 1 };
  }
  return withRepo(store, repo, current);
}

/** Refreshes the classes already remembered for `repo` after a use; never creates one. */
export function touchAuthorization(store: AuthorizationStore, repo: string, classes: readonly DeliveryClass[], nowIso: string): AuthorizationStore {
  const existing = store.repos[repo];
  if (existing === undefined) return store;
  const current: Partial<Record<DeliveryClass, AuthorizationUse>> = { ...existing };
  for (const cls of classes) {
    const use = current[cls];
    if (use !== undefined) current[cls] = { firstAt: use.firstAt, lastAt: nowIso, uses: use.uses + 1 };
  }
  return withRepo(store, repo, current);
}

function isFresh(use: AuthorizationUse | undefined, nowMs: number): boolean {
  if (use === undefined) return false;
  const last = Date.parse(use.lastAt);
  return !Number.isNaN(last) && nowMs - last <= AUTHORIZATION_TTL_MS;
}

/** True only when `classes` is non-empty and every one is remembered for `repo` and used within the last 30 days. */
export function isAuthorized(store: AuthorizationStore, repo: string, classes: readonly DeliveryClass[], nowMs: number): boolean {
  const entry = store.repos[repo];
  if (entry === undefined || classes.length === 0) return false;
  return classes.every((cls) => isFresh(entry[cls], nowMs));
}

/** Forgets one class of `repo`, or the whole repository when no class is given. */
export function forgetAuthorization(store: AuthorizationStore, repo: string, cls?: DeliveryClass): AuthorizationStore {
  if (cls === undefined) return withRepo(store, repo, {});
  const current: Partial<Record<DeliveryClass, AuthorizationUse>> = { ...store.repos[repo] };
  delete current[cls];
  return withRepo(store, repo, current);
}

/** Drops every class past its 30 days, and every repository left with none. */
export function pruneExpired(store: AuthorizationStore, nowMs: number): AuthorizationStore {
  let next = store;
  for (const [repo, entry] of Object.entries(store.repos)) {
    const kept: Partial<Record<DeliveryClass, AuthorizationUse>> = {};
    for (const cls of DELIVERY_CLASSES) {
      const use = entry[cls];
      if (use !== undefined && isFresh(use, nowMs)) kept[cls] = use;
    }
    next = withRepo(next, repo, kept);
  }
  return next;
}
