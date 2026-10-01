/**
 * gate-files -- PreToolUse hook on Claude Code's file tools (Edit, Write,
 * MultiEdit, NotebookEdit). 0.6.17 T2 (JEVADV-90): refuses a write to one of
 * the files the gate or the model router decides from and says nothing for
 * every other file. The decision is gate-files.ts's.
 *
 * It runs on every edit, so it stays cheap: no Jev call, no network, no git,
 * no log line on a pass. Plain JavaScript on purpose: loading the first
 * TypeScript module costs Node about 22 ms (measured, Node 24.15), so a path
 * that cannot be one of those files is passed before any is loaded. Every
 * protected file sits in a directory named `orca-supervisor`
 * (src/core/paths.ts, on every platform), in a directory an override
 * variable names, is one of Orca's two profile files, or sits in the
 * plugin's Orca storage directory, named by the plugin's id; anything else
 * is not one of them. It fails open like the gate: an unreadable payload or any
 * error is a silent pass.
 */
import { readFileSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// The tools that write a file; the settings.json matcher names the same four.
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const OVERRIDES = ['ORCA_SUPERVISOR_CONFIG_DIR', 'ORCA_SUPERVISOR_CACHE_DIR', 'ORCA_USER_DATA_PATH']
// The plugin's Orca storage directory is named by its id (src/core/orca_enablement.ts PLUGIN_ID).
const NEEDLES = ['orca-supervisor', 'orca-data.json', 'orca-profile-index.json', 'ab2web.orca-jev-advisor']

/** The path a file tool is about to write, absolute; null for any other tool or a payload that names none. */
function targetPath (raw) {
  const record = JSON.parse(raw)
  if (typeof record !== 'object' || record === null || !FILE_TOOLS.has(record.tool_name)) return null
  const input = record.tool_input
  if (typeof input !== 'object' || input === null) return null
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  if (path === null || path.length === 0) return null
  const cwd = typeof record.cwd === 'string' ? record.cwd : process.cwd()
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function realpathOrSelf (path) {
  try {
    return realpathSync(path)
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}

function mayBeOwnFile (path) {
  const seen = `${path}\n${realpathOrSelf(path)}`
  const overrides = OVERRIDES.map((name) => process.env[name]).filter((value) => typeof value === 'string' && value.length > 0)
  return NEEDLES.some((needle) => seen.includes(needle)) || overrides.some((dir) => seen.includes(dir))
}

try {
  const path = targetPath(readFileSync(0, 'utf8'))
  if (path !== null && mayBeOwnFile(path)) {
    const { ownFileRefusal } = await import('./gate-files.ts')
    const output = await ownFileRefusal(path)
    if (output !== null) writeSync(1, output)
  }
} catch {
  // Fails open, like the gate: no verdict, the edit follows its normal course.
}
process.exit(0)
