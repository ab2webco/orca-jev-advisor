#!/usr/bin/env node
/**
 * Photographs the running-agents band (0.6.14 T2) outside a live session.
 *
 * The band is a `ui.render` hook on the `AbovePrompt` site: it returns a
 * plain-data tree of Box and Text elements, which Claude Code paints in the
 * terminal. Nothing outside a live session paints that tree, so this script
 * does the two halves it can do honestly:
 *
 *   1. It runs the REAL hook (hooks/index.ts's `register`, the same module
 *      the plugin ships) against a minimal host that holds the owner's case
 *      of 2026-09-30 in `$.state` and `$.agent.list()`: four agents running,
 *      two of the same type, one started before the plugin loaded (the
 *      hook's own session.start sees it running, 0.6.20 T2). 0.6.20 T2 adds
 *      two agent-team teammates (one before its first step, one after it),
 *      and an agent nothing recorded that started after the load.
 *   2. It paints the returned tree as a terminal would -- one cell per
 *      character, `bold` bold, `dimColor` dim -- at 200, 120, 80 and 40
 *      columns, dark and light, and photographs each with Playwright.
 *
 * What it does not show is the engine's own paint (its fonts, its colours,
 * the prompt under the band): that is the live check's. Every line's length
 * is measured against the band's width and the script fails if one is over.
 *
 * Usage: node scripts/screenshot-band.mjs [--out <dir>]
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { register } from '../adapters/claude/mod-skills/hooks/index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const outFlag = process.argv.indexOf('--out')
const OUT_DIR = outFlag >= 0 && process.argv[outFlag + 1] ? process.argv[outFlag + 1] : join(ROOT, 'odd/qa/shots-0.6.20')
const COLUMNS = [200, 120, 80, 40]
const THEMES = {
  dark: { background: '#1e1e1e', foreground: '#d4d4d4', label: '#8a8a8a' },
  light: { background: '#fbfbfb', foreground: '#1f1f1f', label: '#6b6b6b' },
}
const LOCALES = ['es', 'en']

// The owner's four agents, with a neutral project prefix. agent-0 has no
// record: it started before the plugin loaded. 0.6.20 T2: tm-2 is a teammate
// recorded at its first step, with the model its answer reported; tm-1 is a
// teammate before its first step; agent-9 started after the load, unseen.
const RECORDED = [
  { id: 'agent-1', type: 'acme-frontend-developer', description: 'Adding Definition of Done to spec.md', label: 'Opus 5.5', effort: 'xhigh', effortSource: 'inherited', why: 'explicit', wouldUse: null },
  { id: 'agent-2', type: 'general-purpose', description: 'Creating a worktree for verify-report generation', label: 'Sonnet 5.5', effort: 'medium', effortSource: 'jev', why: 'lowered', wouldUse: null },
  { id: 'agent-3', type: 'acme-backend-developer', description: 'Watching CI checks on PR 867', label: 'Sonnet 5.5', effort: 'high', effortSource: 'inherited', why: 'explicit', wouldUse: null },
  { id: 'areviewer-1a2b', type: 'teammate', description: 'reviewer', label: 'Opus 5.5', effort: 'high', effortSource: 'inherited', why: 'teammate', wouldUse: null },
]
/** What the host runs at the load's session.start: agent-0 is already there. */
const AT_LOAD = [
  { id: 'agent-0', type: 'acme-frontend-developer', description: 'Reading playwright.config.ts', status: 'running' },
]
const LISTED = [
  ...RECORDED.map((agent) => ({ id: agent.id, type: agent.type, description: agent.description, status: 'running' })),
  ...AT_LOAD,
  { id: 'aresearcher-3c4d', type: 'teammate', description: 'researcher', status: 'running' },
  { id: 'agent-9', type: 'Explore', description: 'Find the band hook', status: 'running' },
]

/** The few `$` nouns the band's hook reads, holding the case above; `listed` is what `$.agent.list()` returns. */
function host (locale, listed = LISTED) {
  return {
    env: { get: async (name) => (name === 'HOME' ? '/home/dev' : undefined) },
    fs: {
      exists: async (path) => path.endsWith('/locale'),
      read: async (path) => {
        if (path.endsWith('/locale')) return locale
        throw new Error(`not in this host: ${path}`)
      },
    },
    state: {
      get: async (ref) => ({ value: ref.key === 'runningSubagents' ? { agents: RECORDED } : undefined, version: 1 }),
      set: async () => ({ isSet: false, version: 1 }),
    },
    agent: { list: async () => listed },
    ui: {
      status: () => {},
      resolve: () => ({
        Box: (props) => ({ type: 'Box', props }),
        Text: (props) => ({ type: 'Text', props }),
      }),
    },
  }
}

/** The band's hook, after the load's own session.start has seen what the host ran then. */
async function bandHook () {
  let hook = null
  let start = null
  register((event, matcher, fn) => {
    if (event === 'ui.render' && matcher?.component === 'AbovePrompt') hook = fn
    if (event === 'session.start') start = typeof matcher === 'function' ? matcher : fn
  }, { typesafeApiKey: 'unused' })
  if (hook === null) throw new Error('hooks/index.ts registered no AbovePrompt band')
  if (start === null) throw new Error('hooks/index.ts registered no session.start')
  await start(host('en', AT_LOAD), { source: 'startup' }, async (e) => e)
  return hook
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A Text's children as HTML spans, its style carried down. */
function paint (node, style = {}) {
  if (typeof node === 'string') {
    const css = [style.bold ? 'font-weight:700' : '', style.dim ? 'opacity:.55' : ''].filter(Boolean).join(';')
    return css ? `<span style="${css}">${escape(node)}</span>` : escape(node)
  }
  const next = { bold: style.bold || node.props.bold === true, dim: style.dim || node.props.dimColor === true }
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children]
  return children.map((child) => paint(child, next)).join('')
}

function plain (node) {
  if (typeof node === 'string') return node
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children]
  return children.map(plain).join('')
}

const hook = await bandHook()
await mkdir(OUT_DIR, { recursive: true })
const browser = await chromium.launch()
const overflows = []
const shots = []
try {
  for (const locale of LOCALES) {
    for (const columns of COLUMNS) {
      const event = { component: 'AbovePrompt', surface: 'terminal', requestId: 'above-prompt', props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 19 }, view: {} } }
      const tree = await hook(host(locale), event, async () => ({ type: 'engine', ref: 0 }))
      if (tree.type !== 'Box') throw new Error(`${locale}@${columns}: the band drew nothing (${JSON.stringify(tree)})`)
      const lines = tree.props.children
      for (const line of lines) if (plain(line).length > columns) overflows.push(`${locale}@${columns}: ${plain(line).length} cells: ${plain(line)}`)
      for (const [theme, colors] of Object.entries(THEMES)) {
        const html = `<!doctype html><meta charset="utf-8"><style>
          body{margin:0;padding:16px;background:${colors.background};color:${colors.foreground};font:14px/1.35 Menlo,Monaco,"DejaVu Sans Mono",monospace}
          .label{color:${colors.label};font-size:12px;margin-bottom:8px}
          .band{width:${columns}ch;white-space:pre;overflow:hidden;outline:1px dashed ${colors.label}}
        </style><div class="label">AbovePrompt band · ${columns} columns · ${locale} · ${theme} (the hook's own tree, painted cell by cell)</div>
        <div class="band">${lines.map((line) => paint(line)).join('\n')}</div>`
        const page = await browser.newPage({ viewport: { width: Math.ceil(columns * 8.6) + 48, height: 260 }, deviceScaleFactor: 2 })
        await page.setContent(html)
        const file = join(OUT_DIR, `band-${locale}-${columns}-${theme}.png`)
        await page.screenshot({ path: file, fullPage: true })
        await page.close()
        shots.push(file)
      }
    }
  }
} finally {
  await browser.close()
}
if (overflows.length > 0) {
  process.stderr.write(`band lines wider than the band:\n${overflows.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`${shots.length} band shots in ${OUT_DIR.startsWith(ROOT) ? OUT_DIR.slice(ROOT.length + 1) : OUT_DIR}\n`)
