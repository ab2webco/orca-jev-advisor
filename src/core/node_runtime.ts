// Which Node the installed hooks run on. The hooks are `.ts` files that rely
// on Node's type stripping, so they need Node 24 or newer; under Orca the
// installer used to write a bare `node`, resolved later from whatever PATH
// the GUI happened to have. Pure: the installer does the I/O (listing
// directories, running `--version`) and hands the results in here.

import { posix, win32 } from "node:path";

export const MIN_NODE_MAJOR = 24;

export type NodeState = "ok" | "too-old" | "missing";

export type NodeInfo = {
  readonly state: NodeState;
  readonly path: string | null;
  readonly version: string | null;
};

export type ParsedNodeVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
};

export function parseNodeVersion(text: string): ParsedNodeVersion | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: text.trim().split(/\s/)[0] ?? "" };
}

/** `versionText` is what `<path> --version` printed. */
export function classifyNode(path: string, versionText: string): NodeInfo {
  const parsed = parseNodeVersion(versionText);
  if (parsed === null) return { state: "missing", path: null, version: null };
  return { state: parsed.major >= MIN_NODE_MAJOR ? "ok" : "too-old", path, version: parsed.raw };
}

export type ManagedNodeRoot = {
  readonly root: string;
  /** What sits between a version directory and the `node` binary. */
  readonly binDir: string;
};

/** Directories whose children are one installed Node version each. */
export function managedNodeRoots(platform: NodeJS.Platform, home: string): readonly ManagedNodeRoot[] {
  if (platform === "win32") return [];
  return [
    { root: posix.join(home, ".nvm", "versions", "node"), binDir: "bin" },
    { root: posix.join(home, ".local", "share", "fnm", "node-versions"), binDir: posix.join("installation", "bin") },
    { root: posix.join(home, ".fnm", "node-versions"), binDir: posix.join("installation", "bin") },
    { root: posix.join(home, "Library", "Application Support", "fnm", "node-versions"), binDir: posix.join("installation", "bin") },
  ];
}

function compareVersionNamesDesc(a: string, b: string): number {
  const pa = parseNodeVersion(a);
  const pb = parseNodeVersion(b);
  if (pa === null || pb === null) return pa === null ? (pb === null ? 0 : 1) : -1;
  return pb.major - pa.major || pb.minor - pa.minor || pb.patch - pa.patch;
}

export type NodeCandidateInput = {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly pathEnv: string;
  /** A delimiter-separated list of node binaries that replaces every other source (tests). */
  readonly override: string | undefined;
  /** Version directory names found under each managed root, keyed by root. */
  readonly managed: Readonly<Record<string, readonly string[]>>;
};

export function nodeCandidatePaths(input: NodeCandidateInput): readonly string[] {
  const win = input.platform === "win32";
  const path = win ? win32 : posix;
  const delimiter = win ? ";" : ":";
  const binary = win ? "node.exe" : "node";
  if (input.override !== undefined) return dedupe(input.override.split(delimiter).filter((p) => p.length > 0));

  const found: string[] = [];
  for (const dir of input.pathEnv.split(delimiter)) if (dir.length > 0) found.push(path.join(dir, binary));
  if (win) {
    found.push(path.join("C:\\Program Files\\nodejs", binary));
  } else {
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", path.join(input.home, ".volta", "bin")]) found.push(path.join(dir, binary));
    for (const { root, binDir } of managedNodeRoots(input.platform, input.home)) {
      const names = [...(input.managed[root] ?? [])].sort(compareVersionNamesDesc);
      for (const name of names) found.push(path.join(root, name, binDir, binary));
    }
    found.push(path.join(input.home, ".asdf", "shims", binary), path.join("/usr/bin", binary));
  }
  return dedupe(found);
}

function dedupe(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}
