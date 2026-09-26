// JEVADV-43 -- mod-skills has never loaded on any machine, in part because
// the INSTALLED copy under `~/.claude/skills/orca-jev-mod-skills/` used to
// be a flat copy of `adapters/claude/mod-skills/` alone: its hooks module
// imports `../../../../src/core/*`, which escapes any plugin folder rooted
// there, so the engine refused it outright.
//
// The fix: the installed copy mirrors the REPO's own relative layout. A
// file that lived at `adapters/claude/mod-skills/hooks/index.ts` is copied
// to `<skills dir>/orca-jev-mod-skills/adapters/claude/mod-skills/hooks/
// index.ts`, and `src/core/jev.ts` lands at `<skills dir>/orca-jev-mod-
// skills/src/core/jev.ts` -- so index.ts's own `../../../../src/core/jev.ts`
// specifier resolves inside the copy exactly as it does inside the repo.
// Only two files are then generated fresh at the copy's root:
// `.claude-plugin/plugin.json` (the manifest) and `hooks/hooks.json` (which
// points at `../adapters/claude/mod-skills/hooks/index.ts`, the mirrored
// entry).
//
// Everything here is pure: no `node:fs`, no real filesystem access. Callers
// (install-claude-integration.mjs, and this module's own tests) inject a
// `ModSkillsCopyReader` -- real files in production, a fake in-memory map in
// tests -- so the walker, the digest and the manifest builders are all
// exercised without ever touching a real HOME, `.claude` or `.config`
// directory, and without `mkdtempSync` ceremony for the parts of this that
// do not actually need a disk at all.

/** Reads one repo-relative file's text content, e.g. `"adapters/claude/mod-skills/hooks/index.ts"` or `"src/core/jev.ts"`. Thrown errors (a missing file) are the caller's to handle. */
export interface ModSkillsCopyReader {
  readonly read: (repoRelativePath: string) => Promise<string>;
}

/** One generated file that is not copied from the repo, but produced fresh at install time (the plugin manifest, the root hooks.json) -- see installModSkillsCopyPlan.ts's own module doc in install-claude-integration.mjs for how these two are built. `path` is relative to the copy's own root, the same way a closure path is relative to the repo root. */
export interface ModSkillsGeneratedFile {
  readonly path: string;
  readonly content: string;
}

const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;

function isRelativeSpecifier(specifier: string): boolean {
  return RELATIVE_SPECIFIER_PATTERN.test(specifier);
}

/**
 * Every module specifier a TypeScript/JavaScript file names as an import or
 * re-export source: `import ... from 'X'`, `import type ... from 'X'`,
 * `export ... from 'X'`, and the bare side-effect form `import 'X'`. One
 * regular expression over the whole file (rather than a line scanner) so a
 * multi-line `import { a, b, c } from '...'` block -- hooks/index.ts has
 * several -- is still matched as a single specifier.
 */
const IMPORT_SPECIFIER_PATTERN = /(?:^|[\s;])(?:import|export)(?:\s+type)?(?:[^'"();]*?\bfrom)?\s*['"]([^'"]+)['"]/gm;

function extractSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** Resolves a relative specifier (`"../../../../src/core/jev.ts"`) named from `fromRepoRelativePath` (`"adapters/claude/mod-skills/hooks/index.ts"`) into the repo-relative path it names (`"src/core/jev.ts"`). Pure forward-slash arithmetic -- no `node:path` -- the same discipline hooks/runtime.ts's own `computeHomePaths` already follows, since this module's callers may run in a context with no `node:path` guarantee either. */
export function resolveModSkillsSpecifier(fromRepoRelativePath: string, specifier: string): string {
  const fromDir = fromRepoRelativePath.split("/").slice(0, -1);
  const segments = [...fromDir, ...specifier.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}

function isTestFile(repoRelativePath: string): boolean {
  return repoRelativePath.endsWith(".test.ts") || repoRelativePath.endsWith(".test.mts");
}

/**
 * The transitive closure of `entryRepoRelativePath`'s own relative imports
 * (and the relative imports of everything it imports, recursively),
 * expressed as repo-relative paths, entry included, sorted for a
 * deterministic result. Follows every relative specifier regardless of
 * whether the importing statement is `import` or `import type` -- a
 * type-only edge costs nothing to include and a missed one would silently
 * break the copy, so this errs on the side of completeness rather than
 * trying to tell "erased at runtime" apart from "still needed to resolve."
 *
 * A bare specifier (`'claude-code'`, a bare package name) is never
 * followed -- there is no repo file to copy for it, and `claude-code`
 * itself is a virtual module the engine provides, never a real file. A
 * `*.test.ts`/`*.test.mts` target is excluded even if something in the
 * closure names one (nothing in this mod does, but a future file might, and
 * a test file has no business shipping in an installed copy).
 */
export async function walkModSkillsClosure(entryRepoRelativePath: string, reader: ModSkillsCopyReader): Promise<readonly string[]> {
  const visited = new Set<string>();
  const queue: string[] = [entryRepoRelativePath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current) || isTestFile(current)) continue;
    visited.add(current);
    const content = await reader.read(current);
    for (const specifier of extractSpecifiers(content)) {
      if (!isRelativeSpecifier(specifier)) continue;
      const resolved = resolveModSkillsSpecifier(current, specifier);
      if (isTestFile(resolved) || visited.has(resolved)) continue;
      queue.push(resolved);
    }
  }
  return [...visited].sort();
}

/**
 * A stable digest over the exact bytes that make an installed copy "this
 * version of the mod": every closure file's own content, plus every
 * generated file's content -- so a single changed source byte, or a
 * changed manifest (a version bump, a description edit), both change the
 * digest, and an install that finds a mismatch knows to refresh rather than
 * trust a copy that merely happens to sit at the same path forever (the
 * exact gap a dev-loaded plugin used to fall through: only the source path
 * was ever recorded before this, never its content).
 *
 * Ordering never affects the result: both path lists are sorted before
 * hashing, independent of the order `closurePaths`/`generatedFiles` arrive
 * in.
 */
export async function computeModSkillsDigest(closurePaths: readonly string[], reader: ModSkillsCopyReader, generatedFiles: readonly ModSkillsGeneratedFile[]): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const path of [...closurePaths].sort()) {
    hash.update(path);
    hash.update("\u0000");
    hash.update(await reader.read(path));
    hash.update("\u0000");
  }
  for (const file of [...generatedFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/** Every path an installed copy should contain right now: the closure, plus every generated file's own path. Sorted, deduplicated (a generated path can never collide with a closure path in practice, but a set guards it anyway). */
export function expectedModSkillsPaths(closurePaths: readonly string[], generatedFiles: readonly ModSkillsGeneratedFile[]): readonly string[] {
  return [...new Set([...closurePaths, ...generatedFiles.map((file) => file.path)])].sort();
}

/** Which of `actualPaths` (every file a copy currently contains, repo-relative to the copy's own root) no longer belongs there given `expectedPaths` -- what install must remove so a stale copy does not keep shipping a file the current source tree no longer has. */
export function staleModSkillsPaths(actualPaths: readonly string[], expectedPaths: readonly string[]): readonly string[] {
  const expected = new Set(expectedPaths);
  return actualPaths.filter((path) => !expected.has(path));
}

/** The `.claude-plugin/plugin.json` manifest the engine requires: `author` MUST be an object (a bare string is rejected -- the diagnosis's own reason #1). */
export interface ModSkillsPluginManifestInput {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly authorName: string;
}

export function buildModSkillsPluginManifest(input: ModSkillsPluginManifestInput): string {
  const manifest = { name: input.name, version: input.version, description: input.description, author: { name: input.authorName } };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The root `hooks/hooks.json` the copy needs: `modulePath` is relative to the hooks.json file itself, e.g. `"../adapters/claude/mod-skills/hooks/index.ts"` once the entry is mirrored at its repo-relative path. */
export interface ModSkillsHooksManifestInput {
  readonly description: string;
  readonly modulePath: string;
}

export function buildModSkillsHooksManifest(input: ModSkillsHooksManifestInput): string {
  const manifest = { description: input.description, modules: [input.modulePath] };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
