// Shell words as written, quotes kept, for the readers that must know how a
// word was quoted: a quoted `~` is not home, a quoted `-delete` is still an
// option to find, and a `$`, a backtick or a `{` outside single quotes is
// something the shell rewrites before the program sees it. tokenize
// (git_discard.ts) drops the quotes, so it cannot answer these. Pure: no I/O.
import { tokenize } from "./git_discard.ts";

/** The shell words of `text` as written, quotes and backslashes kept, split on unquoted blanks. */
export function rawWords(text: string): readonly string[] {
  const words: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "\\" && !single) {
      current += text.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    if (/\s/.test(char) && !single && !double) {
      if (current.length > 0) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) words.push(current);
  return words;
}

/** What the program receives for one raw word when the shell rewrites nothing: quotes and backslashes removed. */
export function wordText(raw: string): string {
  return tokenize(raw).join("");
}

/** Whether a raw word holds a character the shell acts on: `$` or a backtick outside single quotes, a brace or `<`/`>` outside any quotes. */
function hasActive(raw: string, active: (char: string, double: boolean) => boolean): boolean {
  let single = false;
  let double = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char === "\\" && !single) index += 1;
    else if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (!single && active(char, double)) return true;
  }
  return false;
}

/** A `$`, a backtick or a brace the shell expands before the program runs: the word's value is not in the text. */
export function hasExpansion(raw: string): boolean {
  return hasActive(raw, (char, double) => char === "$" || char === "`" || (!double && (char === "{" || char === "}")));
}

/** A `<` or `>` outside quotes inside a word, where the shell splits it into a redirection (`hi>x`). */
export function hasUnquotedRedirect(raw: string): boolean {
  return hasActive(raw, (char, double) => !double && (char === "<" || char === ">"));
}

/** An option spelled with quotes or a backslash (`-de''lete`, `'--pre'`, `\-delete`): the program still reads it as the option. */
export function isQuotedOption(raw: string): boolean {
  return /['"\\]/.test(raw) && wordText(raw).startsWith("-");
}

/** A word whose value cannot be read from the text: an expansion, or an option spelled with quotes. */
export function isUnreadableWord(raw: string): boolean {
  return hasExpansion(raw) || isQuotedOption(raw);
}

/** Whether `name` (`--o`, `--out`, `--output=x`'s name) is GNU getopt's unambiguous-prefix spelling of `option`, at least `minimum` characters long. */
export function isLongOptionPrefix(name: string, option: string, minimum: number): boolean {
  return name.length >= minimum && option.startsWith(name);
}
