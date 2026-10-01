// 0.6.17 T2 (JEVADV-90): the model cannot rewrite its own judge. The gate
// and the model router decide from files the Advisor panel, the worker and
// the installer write (through Orca's storage or the installer, never
// through a Claude Code tool call): the policies and catalog mirrors, the
// team owners, the deny-tier switches, the models catalog, the key. An
// agent that edits one of them changes what the next command is judged by,
// so a write to any of them, from Bash or from a file tool, is a local
// refusal. Reading them stays allowed, and so does every other file.
//
// Matched against the REAL directories the gate resolves for this HOME, so
// a test suite's throwaway HOME (`/tmp/x/.config/orca-supervisor/...`) is
// never covered, and a command that sets HOME itself has its `~`/`$HOME`
// spellings read as unknown rather than as the real home.
//
// Pure: no I/O. `canonical` (default: the path as written) is how the caller
// resolves a symlink; gate-bash.ts and gate-files.ts pass a realpath. The
// protected set itself is gate_own_paths.ts's.
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { commandWords, locateCommandSegments } from "./command_locations.ts";
import { interpreterHeredocBodies, withoutHeredocBodies, withoutLineContinuations } from "./command_text.ts";
import { tokenize } from "./git_discard.ts";
import { outputRedirectionTargets } from "./redirections.ts";
import { gateOwnFileAt, identity } from "./gate_own_paths.ts";
import type { GateOwnFiles } from "./gate_own_paths.ts";

export { GATE_OWN_CACHE_FILES, GATE_OWN_CONFIG_FILES, GATE_OWN_ORCA_STORAGE_FILES, gateOwnFileAt, gateOwnFiles } from "./gate_own_paths.ts";
export type { GateOwnFiles } from "./gate_own_paths.ts";

/** A protected file at `path`, or the directory holding them, for a removal or a move of a whole directory. */
function ownUnder(path: string, own: GateOwnFiles, canonical: (path: string) => string): string | null {
  const direct = gateOwnFileAt(path, own, canonical);
  if (direct !== null) return direct;
  for (const candidate of [normalize(path), normalize(canonical(path))]) {
    if (own.roots.includes(candidate)) return candidate;
  }
  return null;
}

/** `word` as an absolute path: `~`, `$HOME` and `${HOME}` expanded (unless the command sets HOME), a relative path against `dir`. */
function expand(word: string, dir: string | null, home: string | null): string | null {
  const homeForm = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(word);
  if (homeForm !== null) return home === null ? null : join(home, word.slice(homeForm[0].length));
  if (word.length === 0 || /[$`*?[]/.test(word)) return null;
  if (isAbsolute(word)) return word;
  return dir === null ? null : resolve(dir, word);
}

const WRITES_EVERY_ARGUMENT = new Set(["tee", "rm", "unlink", "shred", "truncate", "touch", "chmod", "chown", "chgrp", "chflags", "xattr", "rmdir", "mv"]);
const WRITES_LAST_ARGUMENT = new Set(["cp", "install", "ln", "rsync", "ditto"]);
const IN_PLACE_EDITORS = new Set(["sed", "gsed", "perl", "ruby"]);
const REMOVES_DIRECTORIES = new Set(["rm", "mv", "rmdir", "trash"]);
const INTERPRETERS = /^(?:python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|osascript)$/;
const REDIRECT = /^(?:\d*|&)>>?\|?$/;
const GLUED_REDIRECT = /^(?:\d*|&)>>?\|?(?=[^>&|])/;

// The code names the real home, not a directory handed to it.
const CODE_HOME = /(?:^|[^\w$])~\/|\$HOME\b|\$\{HOME\}|\bhomedir\s*\(|\bexpanduser\s*\(|\bPath\.home\s*\(|\bprocess\.env\.HOME\b|\bprocess\.env\[['"]HOME['"]\]|\bos\.environ(?:\.get\s*\(\s*|\[)['"]HOME['"]|\bENV\[['"]HOME['"]\]|\bDir\.home\b|\bgetenv\s*\(\s*['"]HOME['"]/;
const SETS_HOME = /(?:^|[\s;&|(])(?:export\s+)?HOME=/;
// A call that writes, removes, moves or copies a file, by name; its own
// arguments are what is read for the file (`open` only with a write mode).
// Names that mean something else on a string or a list (`replace`, `remove`,
// `copy`, `write`) count only qualified by the module that writes files.
const WRITE_CALL = new RegExp(
  String.raw`(?:\b(open|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cpSync|truncate|truncateSync|chmod|chmodSync|symlink|symlinkSync|writeTextFile|file_put_contents)` +
    String.raw`|\bfs(?:\.promises)?\.(rm|cp)|\bos\.(remove|replace)|\bshutil\.(copy\w*|move|rmtree)|\bFile\.(write|delete)|\bIO\.(write)|\bFileUtils\.(\w+))\s*\(`,
  "g",
);
const OPEN_FOR_WRITING = /,\s*(?:mode\s*=\s*)?['"][rwa]?[wax+]b?\+?['"]/;
// A method of a path object that writes it: Python's pathlib, Ruby's Pathname
// (not `replace`, which a string has too).
const PATH_METHOD = /\.(?:write_text|write_bytes|unlink|touch|rename|chmod|open\s*\(\s*['"][wa])\s*\(?/g;
const ASSIGNMENT = /^\s*(?:(?:const|let|var|my|our)\s+)?\$?([A-Za-z_][\w]*)\s*=(?!=)\s*(.+)$/;
// Interpreter options whose next word is the program itself.
const CODE_FLAGS = new Set(["-c", "-e", "-E", "--eval", "-p", "--print"]);

/** The text of the call's arguments: from just after `(` to its matching `)`, at most 600 characters. */
function callArguments(code: string, open: number): string {
  let depth = 1;
  let at = open;
  while (at < code.length && at - open < 600) {
    const char = code[at];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    at += 1;
  }
  return code.slice(open, at);
}

/** The call's arguments split at its own commas, not those of a nested call, list or string. */
function topLevelArguments(args: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let at = 0; at < args.length; at += 1) {
    const char = args[at] ?? "";
    if (quote !== null) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(args.slice(from, at));
      from = at + 1;
    }
  }
  out.push(args.slice(from));
  return out;
}

// Calls whose first two arguments are both paths (a source and a target).
const TWO_PATHS = /^(?:rename|renameSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|replace|copy\w*|move)$/;
const isFileUtilsCall = (call: string): boolean => call.startsWith("FileUtils.");

/** Whether `text` names `file` (under `home`): its full path, its path from home, or its directory names and its file name as separate strings. */
function namesFile(text: string, file: string, home: string): boolean {
  if (text.includes(file)) return true;
  if (!file.startsWith(`${home}/`)) return false;
  const relative = file.slice(home.length + 1);
  if (text.includes(relative)) return true;
  const parts = relative.split("/");
  const name = parts[parts.length - 1] ?? "";
  const nameAsString = [`'${name}'`, `"${name}"`, `/${name}'`, `/${name}"`, `/${name}\``].some((spelling) => text.includes(spelling));
  return nameAsString && parts.slice(0, -1).every((part) => text.includes(part));
}

/**
 * The protected file a piece of interpreter code writes through the real
 * home, or null. Precise on purpose (the 0.6.15 false-positive corpus): the
 * file must be named in the write call's own arguments or receiver, or in
 * the value of a variable that call is handed -- a script that reads a
 * protected file and writes another, or edits a file whose text mentions
 * one, is not a write to it.
 */
function codeWrites(code: string, home: string, own: GateOwnFiles): string | null {
  if (!CODE_HOME.test(code) && !code.includes(home)) return null;
  const files = [...own.files].filter((file) => file.startsWith(`${home}/`)).sort((a, b) => b.length - a.length);
  // Each variable's value with the variables it is built from written out,
  // so `p = base / 'policies.json'` after `base = Path.home() / '.config' /
  // 'orca-supervisor'` reads as the whole path.
  const values = new Map<string, string>();
  const expanded = (text: string): string => text.replace(/(?<![\w$.'"])\$?([A-Za-z_]\w*)\b(?!['"])/g, (word, variable: string) => values.get(variable) ?? word);
  for (const statement of code.split(/\n|;/)) {
    const match = ASSIGNMENT.exec(statement);
    if (match === null) continue;
    const [, name = "", value = ""] = match;
    values.set(name, ` ${expanded(value).slice(0, 2000)} `);
  }
  const named = (text: string): string | null => {
    const full = expanded(text);
    return files.find((file) => namesFile(full, file, home)) ?? null;
  };
  for (const match of code.matchAll(WRITE_CALL)) {
    const args = callArguments(code, (match.index ?? 0) + match[0].length);
    const callee = match.slice(1).find((name) => name !== undefined) ?? "";
    if (callee === "open" && !OPEN_FOR_WRITING.test(args)) continue;
    // Only the path arguments: what is written there is data.
    const paths = topLevelArguments(args).slice(0, TWO_PATHS.test(callee) ? 2 : isFileUtilsCall(match[0]) ? undefined : 1);
    const file = named(paths.join(","));
    if (file !== null) return file;
  }
  for (const match of code.matchAll(PATH_METHOD)) {
    const lineStart = code.lastIndexOf("\n", match.index ?? 0) + 1;
    const file = named(code.slice(lineStart, match.index ?? 0));
    if (file !== null) return file;
  }
  return null;
}

/**
 * The protected file `command` writes, or null. Read segment by segment in
 * command position (after `cd`, inside `bash -c`), on the command with its
 * heredoc bodies removed, so text that only mentions one of
 * these paths stays data; an interpreter's own code (an argument or a
 * heredoc body of the raw `command`) is read for a write API next to the
 * file's name and the real home.
 */
export function commandWritesGateOwnFile(command: string, cwd: string, home: string, own: GateOwnFiles, canonical: (path: string) => string = identity): string | null {
  const inspected = withoutLineContinuations(withoutHeredocBodies(command));
  const homeKnown = SETS_HOME.test(command) ? null : home;
  const code: string[] = [...interpreterHeredocBodies(command)];
  for (const { segment, dir } of locateCommandSegments(inspected, cwd, home)) {
    const words = tokenize(segment);
    const run = commandWords(words);
    const program = basename(run[0] ?? "");
    const at = (word: string): string | null => expand(word, dir, homeKnown);
    const hit = (word: string, removes: boolean): string | null => {
      const path = at(word);
      if (path === null) return null;
      return removes ? ownUnder(path, own, canonical) : gateOwnFileAt(path, own, canonical);
    };
    // 0.6.21 T2: read from the text, so `&>`, `&>>` and `echo hi>x` count too.
    for (const target of outputRedirectionTargets(segment)) {
      const found = hit(target, false);
      if (found !== null) return found;
    }
    const args = run.slice(1).filter((word, index, all) => !REDIRECT.test(word) && !GLUED_REDIRECT.test(word) && !REDIRECT.test(all[index - 1] ?? ""));
    const positional = args.filter((word) => !word.startsWith("-"));
    if (INTERPRETERS.test(program)) {
      for (let index = 1; index < run.length - 1; index += 1) if (CODE_FLAGS.has(run[index] ?? "")) code.push(run[index + 1] ?? "");
    }
    if (program === "dd") {
      for (const word of args) if (word.startsWith("of=")) {
        const found = hit(word.slice(3), false);
        if (found !== null) return found;
      }
      continue;
    }
    const inPlace = IN_PLACE_EDITORS.has(program) && args.some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith("--in-place"));
    if (WRITES_EVERY_ARGUMENT.has(program) || inPlace) {
      for (const word of positional) {
        const found = hit(word, REMOVES_DIRECTORIES.has(program));
        if (found !== null) return found;
      }
      continue;
    }
    if (WRITES_LAST_ARGUMENT.has(program) && positional.length >= 2) {
      const destination = positional[positional.length - 1] ?? "";
      const found = hit(destination, false);
      if (found !== null) return found;
      const destinationPath = at(destination);
      if (destinationPath === null) continue;
      for (const source of positional.slice(0, -1)) {
        const into = gateOwnFileAt(join(destinationPath, basename(source)), own, canonical);
        if (into !== null && (destination.endsWith("/") || own.roots.includes(normalize(destinationPath)))) return into;
      }
    }
  }
  if (homeKnown === null) return null;
  for (const piece of code) {
    const found = codeWrites(piece, homeKnown, own);
    if (found !== null) return found;
  }
  return null;
}
