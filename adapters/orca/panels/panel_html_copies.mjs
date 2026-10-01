// Reads the hand-copied ES5 functions out of a panel's own source, so a test
// can run the same cases against the copy and against its tested .mjs
// original. The panels are sandboxed HTML with no module graph (see
// config.html's own module note), so a copy is the only way they can use
// these helpers; this is how a copy that drifts from its original is caught.
// Used by panel_values.test.mjs and worker-status.test.mjs.

import { readFileSync } from 'node:fs'

/** The source text of `function <name> (...) { ... }` in `source`, braces balanced. */
export function extractFunction (source, name) {
  const startMatch = source.match(new RegExp(`function ${name} *\\([^)]*\\) *\\{`))
  if (startMatch === null || startMatch.index === undefined) throw new Error(`function ${name} not found -- update the test if it moved or was renamed`)
  const start = startMatch.index
  let depth = 0
  let i = start + startMatch[0].length - 1
  do {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') depth -= 1
    i += 1
  } while (depth > 0 && i < source.length)
  return source.slice(start, i)
}

/** The source of one of the panels in this directory. */
export function panelSource (file) {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
}

/** The string a panel assigns to `var <name> = '...'`, or null when it does not. */
export function panelStringVar (file, name) {
  const match = panelSource(file).match(new RegExp(`var ${name} = '([^']*)'`))
  return match === null ? null : match[1]
}

/**
 * The named functions as `file` defines them, evaluated together so one may
 * call another. `globals` supplies the panel globals they read (`t`, a
 * constant), each by name.
 */
export function loadPanelFunctions (file, names, globals = {}) {
  const source = panelSource(file)
  const body = names.map((name) => extractFunction(source, name)).join('\n')
  const keys = Object.keys(globals)
  return new Function(...keys, `'use strict'\n${body}\nreturn { ${names.join(', ')} }`)(...keys.map((key) => globals[key]))
}
