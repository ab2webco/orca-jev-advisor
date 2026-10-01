// 0.6.21 T2 (JEVADV-98): the files a command segment's output redirections
// write, read from the segment's text the way the shell reads it.
//
// Token-based reading (a redirection is a word that starts with `>`) missed
// two forms the shell accepts: `&>file`/`&>>file`, and a redirection glued
// to the word before it (`echo hi>x`, `echo hi>>../x`), where the shell
// splits the word at the unquoted `>`. Reading the text instead, quote by
// quote, finds every operator where the shell does:
//   - `>`, `>>`, `>|`, with or without a descriptor number (`1>`, `2>>`),
//     and `&>`, `&>>`; the file is the next word, spaced or not;
//   - a descriptor copy or close (`2>&1`, `>&2`, `2>&-`) names no file;
//   - `<`, `<<`, `<<<`, `<>` and `<&` write nothing here, as before;
//   - `>(...)` and `<(...)` are process substitutions, not files;
//   - text in quotes or after a backslash is data (`echo "a>b"`);
//   - `$((...))` and `((...))` are arithmetic, where `>` compares;
//   - a `#` that starts a word starts a comment.
// The file keeps `$`, `~`, globs and `$(...)` as written, quotes removed, as
// tokenize (git_discard.ts) does; resolving it is the caller's job.
//
// Pure: no I/O.

const WORD_END = /[\s;&|()<>]/;

/** Index just past the `))` closing the arithmetic `((` at `open`, or the text's end. */
function arithmeticEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/** Index of the character closing the `$(` or backtick opened at `open`. */
function substitutionEnd(text: string, open: number): number {
  if (text[open] === "`") {
    const close = text.indexOf("`", open + 1);
    return close === -1 ? text.length : close + 1;
  }
  let depth = 0;
  let single = false;
  let double = false;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && !single) {
      index += 1;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (single || double) continue;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/** The word starting at `start` (after any blanks), quotes removed, and the index after it. */
function wordAt(text: string, start: number): { readonly word: string; readonly end: number } {
  let index = start;
  while (text[index] === " " || text[index] === "\t") index += 1;
  let word = "";
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\") {
      word += text[index + 1] ?? "";
      index += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      word += text.slice(index + 1, end);
      index = end + 1;
    } else if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) index += 1;
        word += text[index] ?? "";
        index += 1;
      }
      index += 1;
    } else if ((char === "$" && text[index + 1] === "(") || char === "`") {
      const end = substitutionEnd(text, char === "$" ? index + 1 : index);
      word += text.slice(index, end);
      index = end;
    } else if (WORD_END.test(char)) {
      break;
    } else {
      word += char;
      index += 1;
    }
  }
  return { word, end: index };
}

function startsWord(text: string, index: number): boolean {
  return index === 0 || /[\s;&|()]/.test(text[index - 1] ?? "");
}

/** The files the output redirections in `segment` write, in order. */
export function outputRedirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  let single = false;
  let double = false;
  let index = 0;
  while (index < segment.length) {
    const char = segment[index] ?? "";
    if (char === "\\" && !single) {
      index += 2;
      continue;
    }
    if (single) {
      if (char === "'") single = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      double = !double;
      index += 1;
      continue;
    }
    if (double) {
      index += 1;
      continue;
    }
    if (char === "'") {
      single = true;
      index += 1;
      continue;
    }
    if (char === "#" && startsWord(segment, index)) break;
    if (segment.startsWith("$((", index)) {
      index = arithmeticEnd(segment, index + 1);
      continue;
    }
    if (segment.startsWith("((", index) && startsWord(segment, index)) {
      index = arithmeticEnd(segment, index);
      continue;
    }
    if (char === "<") {
      index += segment[index + 1] === ">" || segment[index + 1] === "&" ? 2 : 1;
      continue;
    }
    if (char === "&" && segment[index + 1] === ">") {
      const after = segment[index + 2] === ">" ? index + 3 : index + 2;
      const { word, end } = wordAt(segment, after);
      if (word.length > 0) targets.push(word);
      index = Math.max(end, after);
      continue;
    }
    if (char === ">") {
      if (segment[index + 1] === "(") {
        index += 1;
        continue;
      }
      let after = segment[index + 1] === ">" ? index + 2 : index + 1;
      if (segment[after] === "&") {
        // A descriptor copy or close: `2>&1`, `>&2`, `2>&-`.
        index = after + 1;
        continue;
      }
      if (segment[after] === "|") after += 1;
      const { word, end } = wordAt(segment, after);
      if (word.length > 0) targets.push(word);
      index = Math.max(end, after);
      continue;
    }
    index += 1;
  }
  return targets;
}
