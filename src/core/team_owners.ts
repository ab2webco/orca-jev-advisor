// 0.6.7 T1: the "Repositories your team owns" setting.
//
// A `requires_human` policy protects work that reaches a client. Asked from
// the policy sentence alone, Jev also flagged work that never leaves the
// team: pushing a work branch, opening a pull request in the team's own
// repository. The gate needs a FACT to tell the two apart, and the only one
// it cannot read off disk is who the team is -- this list: the GitHub/GitLab
// owners (users or organisations) whose repositories are the team's own.
// src/core/client_reach.ts (T2) compares a remote's owner against it.
//
// The config panel stores what a person typed (one owner per line) under
// the `teamOwners` storage key; the worker mirrors it to
// `<configDir>/team-owners.json` through write-secret-mirror.mjs, and
// gate-bash.ts reads that file -- the same "worker writes, the hook reads a
// plain file" channel the catalog and policies already use. Every one of
// those three readers goes through parseTeamOwners, so they can never
// disagree about what an owner is.
//
// Empty is the default, and the fail-safe: an empty (or unreadable, or
// malformed) list makes no command "internal", so every decision stays
// exactly what it was before this setting existed.
//
// Pure: no fs, no network.

/** The mirror's file name inside the config dir -- one constant for the writer (write-secret-mirror.mjs) and the reader (gate-bash.ts). */
export const TEAM_OWNERS_MIRROR_FILE = "team-owners.json";

/** A bound on a list a person types by hand -- far above any real team, and it keeps a pasted blob from growing the mirror without limit. */
export const MAX_TEAM_OWNERS = 100;

/** GitHub owners are letters, digits and hyphens; GitLab groups add `.` and `_`. Never a leading punctuation mark, never whitespace. */
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * One typed line as an owner name, or null when it is not one.
 *
 * People paste what they have at hand, so the common shapes resolve to the
 * owner they name: `@acme-team`, a profile URL (`https://github.com/acme-team`),
 * a host path (`github.com/acme-team`), a repository (`acme-team/app`) and a
 * remote (`git@github.com:acme-team/app.git`). Anything else is dropped,
 * never guessed into an owner: a wrong owner would call a client's
 * repository the team's own.
 */
export function normalizeTeamOwner(raw: string): string | null {
  let text = raw.trim().toLowerCase();
  if (text.startsWith("@")) text = text.slice(1);
  // A URL's scheme, or an scp-like remote's `user@host:` prefix.
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^/@:\s]+@[^/:\s]+:/, "");
  const parts = text.split("/").filter((part) => part.length > 0);
  // A leading host (`github.com`, `gitlab.example.org`) when an owner follows
  // it; a host with nothing after it (`https://github.com/`) names no owner.
  if (parts.length > 1 && (parts[0] ?? "").includes(".")) parts.shift();
  else if (parts.length === 1 && text.includes("/") && (parts[0] ?? "").includes(".")) return null;
  const owner = parts[0];
  if (owner === undefined) return null;
  return OWNER_PATTERN.test(owner) ? owner : null;
}

/**
 * The stored or mirrored list, validated: an array of strings, each
 * normalized through normalizeTeamOwner, invalid rows dropped, duplicates
 * removed (first-seen order kept), at most MAX_TEAM_OWNERS. Anything that is
 * not an array reads as empty -- the fail-safe default described above.
 */
export function parseTeamOwners(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const owners: string[] = [];
  for (const row of value) {
    if (typeof row !== "string") continue;
    const owner = normalizeTeamOwner(row);
    if (owner === null || owners.includes(owner)) continue;
    owners.push(owner);
    if (owners.length === MAX_TEAM_OWNERS) break;
  }
  return owners;
}
