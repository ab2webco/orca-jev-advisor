// 0.6.11 T3: no repository name, branch or path reaches Jev in clear.
//
// Secrets already leave through redactSecretsForJev (secret_redaction.ts).
// The names this project adds ON ITS OWN to a Jev request -- the gate's
// repository/branch context, the cross-repo sentence, a destination label,
// the Orca context of a skill or tool decision, the names inside a policy
// rule -- are not secrets by shape, so that pass never touched them. This
// table swaps each one for a stable placeholder (`<repo-1>`, `<branch-1>`,
// `<path-1>`) that keeps what the judgment needs: the SAME name always maps
// to the SAME placeholder within one request, so "the command acts on
// <path-2>, not the session's <path-1>" still says "a different repository".
//
// Protected branch names stay in clear: `main` identifies nobody and it is
// exactly the fact the risk questions weigh. The list mirrors
// push_remote.ts's PROTECTED_BRANCH_NAMES (a test pins the two together);
// it is not imported because this module must stay pure -- the mod-skills
// hook bundle loads it with no filesystem access.
//
// Copy-only: callers render their local text (cache keys, logs, records)
// with IDENTITY_NAMES and only the copy sent to Jev with a fresh table.

export type JevNameKind = "repo" | "branch" | "path";

export interface JevNames {
  /** The placeholder for `value` (registering it), or `value` itself for a clear name. */
  name(kind: JevNameKind, value: string): string;
  /** `text` with every registered value long enough to be a name (four characters for a repository, three for a branch or path) swapped for its placeholder. */
  redactText(text: string): string;
  /** A destination label as Jev may read it: a bare name (or `name (dir)`) is replaced whole; a written description only loses the names already registered. */
  destinationDescription(label: string): string;
}

export const CLEAR_BRANCH_NAMES: readonly string[] = ["main", "master", "production"];

// A value this short in free text is far more likely an ordinary word ("a",
// "is") than a name; replacing it would garble the sentence Jev reads. Only
// free text honors these floors -- name() always replaces.
//
// A repository name is held to four: measured on 1,275 recorded prompts,
// every replacement that hit an ordinary word ("npm run app" -> "npm run
// <repo-1>") came from a repository name under four characters, and none
// came from a branch or a path (those are long and specific).
const MIN_FREE_TEXT_LENGTH: Record<JevNameKind, number> = { repo: 4, branch: 3, path: 3 };

// A name made of these characters is one token; a boundary is anything else.
const TOKEN_CHAR = "A-Za-z0-9_.\\-";

// A derived catalog label (worktree_catalog.ts): `repo` or `repo (dir)`.
const DERIVED_LABEL = /^(\S+)(?: \((\S+)\))?$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createJevPseudonyms(): JevNames {
  const placeholders = new Map<string, string>();
  const counts: Record<JevNameKind, number> = { repo: 0, branch: 0, path: 0 };

  const name = (kind: JevNameKind, value: string): string => {
    if (value.length === 0) return value;
    if (kind === "branch" && CLEAR_BRANCH_NAMES.includes(value)) return value;
    const key = `${kind}\u0000${value}`;
    const existing = placeholders.get(key);
    if (existing !== undefined) return existing;
    counts[kind] += 1;
    const placeholder = `<${kind}-${counts[kind]}>`;
    placeholders.set(key, placeholder);
    return placeholder;
  };

  const redactText = (text: string): string => {
    const entries = [...placeholders.entries()]
      .map(([key, placeholder]): [string, string, JevNameKind] => {
        const split = key.indexOf("\u0000");
        return [key.slice(split + 1), placeholder, key.slice(0, split) as JevNameKind];
      })
      .filter(([value, , kind]) => value.length >= MIN_FREE_TEXT_LENGTH[kind])
      .sort((a, b) => b[0].length - a[0].length);
    let result = text;
    for (const [value, placeholder] of entries) {
      const pattern = new RegExp(`(?<![${TOKEN_CHAR}])${escapeRegExp(value)}(?![A-Za-z0-9_\\-])`, "g");
      result = result.replace(pattern, placeholder);
    }
    return result;
  };

  const destinationDescription = (label: string): string => {
    const derived = DERIVED_LABEL.exec(label);
    if (derived === null) return redactText(label);
    const repo = name("repo", derived[1] as string);
    return derived[2] === undefined ? repo : `${repo} (${name("repo", derived[2])})`;
  };

  return { name, redactText, destinationDescription };
}

export interface OrcaContextNames {
  readonly worktree: string | null;
  readonly project: string | null;
  readonly branch: string | null;
}

/** The Orca context a skill or tool decision sends Jev: each known name as a placeholder, an unknown one still null. */
export function orcaContextForJev(context: OrcaContextNames, names: JevNames = createJevPseudonyms()): OrcaContextNames {
  return {
    worktree: context.worktree === null ? null : names.name("path", context.worktree),
    project: context.project === null ? null : names.name("repo", context.project),
    branch: context.branch === null ? null : names.name("branch", context.branch),
  };
}

/** The local rendering: every name in clear. Never used for a Jev request. */
export const IDENTITY_NAMES: JevNames = {
  name: (_kind, value) => value,
  redactText: (text) => text,
  destinationDescription: (label) => label,
};
