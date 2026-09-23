/**
 * gate-bash — PreToolUse hook. Decide si un comando se ejecuta, se pregunta
 * o se bloquea, sin que el agente tenga que acordarse de nada.
 *
 * El problema de meter un modelo en el camino de cada comando es el costo y la
 * latencia. Por eso hay tres niveles, y solo el tercero llama a Jev:
 *
 *   0. El filtro `if` de settings.json. El hook ni siquiera se lanza para
 *      comandos que no calzan con los patrones de interes. Esto lo hace Claude
 *      Code antes de gastar un proceso.
 *   1. Listas locales, en microsegundos. Lo inofensivo pasa; lo catastrofico
 *      se bloquea. Sin red, sin costo.
 *   2. Solo lo que queda en el medio va a Jev, y el resultado se cachea por
 *      comando y repositorio, asi que la segunda vez tampoco cuesta.
 *
 * Falla abierto SIEMPRE: cualquier error, timeout o falta de llave termina en
 * salida limpia sin veredicto, y el permiso sigue su curso normal. Un gate que
 * rompe el trabajo cuando se cae la red es peor que no tener gate.
 *
 * This is the Claude Code adapter: the three-tier design and the local
 * pattern lists below are this file's own (measured, and correct -- do not
 * fold them into src/core, they are not Jev questions). The Jev call
 * itself (question shapes, retry/backoff, latency budget, response
 * guards) and the key resolution come from src/core, shared with the Orca
 * plugin adapter -- see adapters/orca/.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildActionGateQuestions, buildActionGateState, decideAction } from '../../src/core/decisions.ts'
import { callJev, JevRequestError } from '../../src/core/jev.ts'
import { resolveApiKey } from '../../src/core/secrets.ts'
import { DEFAULT_LOCALE, parseLocaleFile, translate } from '../../src/core/i18n.ts'
import type { Locale } from '../../src/core/i18n.ts'
import { GATE_CATALOG } from '../../src/core/i18n_gate.ts'
import type { GateKey } from '../../src/core/i18n_gate.ts'
import { buildGateDecisionRecord, serializeGateRecord } from '../../src/core/gate_measurement.ts'
import type { GateSource, GateVerdict } from '../../src/core/gate_measurement.ts'
import { normalizePlatform, resolveCacheDir, resolveConfigDir } from '../../src/core/paths.ts'

// `os.homedir()` is already HOME-vs-USERPROFILE correct per platform;
// resolveCacheDir/resolveConfigDir only decide the `.cache`/`.config` vs
// `%LOCALAPPDATA%`/`%APPDATA%` convention on top of it -- see
// src/core/paths.ts.
const PLATFORM = normalizePlatform(process.platform)
const HOME_PATHS = { home: homedir(), appDataDir: process.env.APPDATA, localAppDataDir: process.env.LOCALAPPDATA }
const CACHE_DIR = resolveCacheDir(PLATFORM, HOME_PATHS)
const CONFIG_DIR = resolveConfigDir(PLATFORM, HOME_PATHS)

const CACHE_PATH = join(CACHE_DIR, 'gate-bash.json')
const AUTH_WARNED_PATH = join(CACHE_DIR, 'gate-bash.auth-warned.json')
const LOCALE_PATH = join(CONFIG_DIR, 'locale')
const GATE_LOG_PATH = join(CACHE_DIR, 'gate-decisions.jsonl')
const BUDGET_MS = 1800

/** Desde que arranca el hook, para poder decir cuanto costo decidir. */
const STARTED_AT = Date.now()

/**
 * The config panel's language choice, mirrored to plain text next to (not
 * inside) the API key's fallback file -- this process is a plain Node
 * script Claude Code spawns per command, with no channel back into Orca's
 * own `storage`, so the worker writes the choice out where this can just
 * read it. Not Orca's own `contributes.languagePacks` (see
 * src/core/i18n.ts's note): that mechanism replaces Orca's whole UI
 * language, not one plugin's own messages. Missing or unreadable defaults
 * to DEFAULT_LOCALE, same as an unrecognized value -- a hook must never
 * fail over something as small as which language to speak.
 */
function resolveLocale(): Locale {
  try {
    return parseLocaleFile(readFileSync(LOCALE_PATH, 'utf8'))
  } catch {
    return DEFAULT_LOCALE
  }
}

const LOCALE = resolveLocale()
const t = (key: GateKey, params?: Readonly<Record<string, string>>): string => translate(GATE_CATALOG, LOCALE, key, params)

type Decision = 'allow' | 'deny' | 'ask'

/** Nivel 1a: se ejecuta sin consultar a nadie. Lectura, inspeccion, pruebas. */
const OBVIOUSLY_SAFE: readonly RegExp[] = [
  /^\s*(ls|pwd|cat|head|tail|wc|which|echo|date|whoami|env)\b/,
  /^\s*git\s+(status|diff|log|show|remote|rev-parse|blame)\b/,
  // `git branch` solo en sus formas de lectura: -d, -D, -m y -M borran o renombran.
  /^\s*git\s+branch(\s+(-a|-r|-v|-vv|--all|--list|--show-current))*\s*$/,
  /^\s*git\s+stash\s+list\b/,
  /^\s*(npm|pnpm|yarn|bun)\s+(test|run test|run lint|run typecheck|run build)\b/,
  /^\s*(jq|rg|grep|find|sed -n|awk)\b/,
  /^\s*gh\s+(pr|issue|run|repo)\s+(list|view|status|checks)\b/,
]

/** Nivel 1b: no se ejecuta nunca sin intervencion humana explicita. `why` is a catalog key, resolved at emit time in the panel's chosen language. */
const NEVER_SILENTLY: readonly { readonly pattern: RegExp; readonly why: GateKey }[] = [
  { pattern: /git\s+push\b.*(--force|-f)\b/, why: 'rule.forcePush' },
  { pattern: /git\s+push\b.*\b(main|master|production)\b/, why: 'rule.pushProtected' },
  { pattern: /rm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/, why: 'rule.rmRf' },
  { pattern: /git\s+(reset\s+--hard|clean\s+-[a-z]*f)/, why: 'rule.resetClean' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, why: 'rule.dropTable' },
  { pattern: /kubectl\s+(delete|drain)\b/, why: 'rule.kubectlDelete' },
  { pattern: /\b(terraform|tofu)\s+(apply|destroy)\b/, why: 'rule.terraform' },
  { pattern: /curl[^|]*\|\s*(bash|sh|zsh)\b/, why: 'rule.curlPipeShell' },
]

type HookInput = { readonly command: string; readonly cwd: string }

function readHookInput(): HookInput | null {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const toolInput = record['tool_input']
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const command = (toolInput as Record<string, unknown>)['command']
  if (typeof command !== 'string' || command.trim().length === 0) return null
  const cwd = typeof record['cwd'] === 'string' ? record['cwd'] : process.cwd()
  return { command, cwd }
}

/**
 * `permissionDecisionReason` solo se ve cuando el veredicto frena algo. Un
 * permiso silencioso deja a Jev invisible: nadie puede saber si opino, si
 * acerto, ni con que numeros -- y lo que no se ve no se puede calibrar. Por eso
 * cada consulta al modelo deja ademas una linea para el usuario.
 */
function emit(decision: Decision, reason: string, visible = true): void {
  const payload: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }
  // Solo se anuncia cuando cambia el curso de las cosas. Un 'permite' por
  // comando es ruido que entierra al unico aviso que importaba.
  if (visible && decision !== 'allow') {
    const verb = t(decision === 'deny' ? 'verb.blocks' : 'verb.asks')
    payload['systemMessage'] = t('statusLine', { verb, reason, ms: String(Date.now() - STARTED_AT) })
  }
  process.stdout.write(JSON.stringify(payload))
}

/** Sin veredicto: el permiso sigue su curso normal. Es la salida por defecto. */
function passThrough(): void {
  process.exit(0)
}

/**
 * Sin veredicto, pero con un aviso: el permiso sigue su curso (fallar
 * abierto sigue siendo correcto), pero el usuario se entera de que Jev no
 * pudo opinar -- fallar abierto en silencio es peor que fallar abierto con
 * una linea. Usado solo para el rechazo de autenticacion (401/403), y solo
 * una vez por marca (ver readAuthWarned/writeAuthWarned): cada comando
 * repitiendo el mismo aviso seria tan ruidoso como no avisar nunca.
 */
function passThroughWithNotice(message: string): void {
  const payload = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    systemMessage: t('notice', { message }),
  }
  process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

type CacheEntry = { readonly decision: Decision; readonly reason: string; readonly at: number }

function cacheKey(command: string, context: string): string {
  return createHash('sha256').update(`${context}\u0000${command}`).digest('hex').slice(0, 24)
}

function readCache(): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, CacheEntry>) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, CacheEntry>): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8')
  } catch {
    // Un cache que no se puede escribir no es motivo para bloquear nada.
  }
}

/**
 * Si el ultimo rechazo de autenticacion ya se avisó -- persistido junto al
 * cache porque este proceso no vive entre comandos (Claude Code lanza el
 * hook una vez por comando): sin esta marca en disco, "una vez" seria en
 * realidad "en cada comando".
 */
function readAuthWarned(): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(AUTH_WARNED_PATH, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as { warned?: unknown }).warned === true
  } catch {
    return false
  }
}

function writeAuthWarned(warned: boolean): void {
  try {
    mkdirSync(dirname(AUTH_WARNED_PATH), { recursive: true })
    writeFileSync(AUTH_WARNED_PATH, JSON.stringify({ warned, at: Date.now() }), 'utf8')
  } catch {
    // Una marca que no se puede escribir no es motivo para bloquear nada;
    // en el peor caso el aviso se repite la proxima vez.
  }
}

/**
 * The project name the measurement log records: the repo's short remote
 * name when there is one (matches what a person calls the project),
 * falling back to the working directory's own name for a repo with no
 * remote. Never the full path, which can carry a username or a client's
 * name in a way the remote's short form does not.
 */
function projectName(cwd: string): string | null {
  let remote = ''
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .replace(/^.*[:/]/, '')
      .replace(/\.git$/, '')
  } catch {
    remote = ''
  }
  if (remote.length > 0) return remote
  try {
    return basename(cwd) || null
  } catch {
    return null
  }
}

/** Appends one measurement record. Best-effort, same as the auth-warned marker: a log that cannot be written is never a reason to block or delay a verdict. */
function appendGateRecord(cwd: string, command: string, source: GateSource, verdict: GateVerdict, latencyMs: number | null): void {
  try {
    mkdirSync(dirname(GATE_LOG_PATH), { recursive: true })
    const record = buildGateDecisionRecord({
      id: randomUUID(),
      at: new Date().toISOString(),
      project: projectName(cwd),
      command,
      source,
      verdict,
      latencyMs,
    })
    appendFileSync(GATE_LOG_PATH, serializeGateRecord(record), 'utf8')
  } catch {
    // Best-effort measurement; never blocks or delays a verdict.
  }
}

/** Lo que hace distinta a una rama de feature de la main de un cliente. */
function repoContext(cwd: string): string {
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  const remote = run(['remote', 'get-url', 'origin']).replace(/^.*[:/]/, '').replace(/\.git$/, '')
  const dirty = run(['status', '--porcelain']).length > 0
  const parts = [
    remote.length > 0 ? `repositorio ${remote}` : 'sin remoto',
    branch.length > 0 ? `rama ${branch}` : 'rama desconocida',
    branch === 'main' || branch === 'master' ? 'es la rama principal compartida' : 'es una rama de trabajo',
    dirty ? 'con cambios sin confirmar' : 'limpio',
  ]
  return parts.join(', ')
}

type JevOutcome =
  | { readonly kind: 'verdict'; readonly decision: Decision; readonly reason: string }
  | { readonly kind: 'auth-rejected'; readonly status: number }
  | { readonly kind: 'none' }

/** Llama a Jev (src/core) y traduce el veredicto de tres ejes a la decision del hook. Nunca lanza. */
async function askJev(apiKey: string, command: string, context: string): Promise<JevOutcome> {
  try {
    const response = await callJev(apiKey, buildActionGateState(command, context), buildActionGateQuestions(), { budgetMs: BUDGET_MS })
    const gate = decideAction(response.answers)
    if (gate.verdict === 'allow') {
      return { kind: 'verdict', decision: 'allow', reason: 'reversible, local and cheap' }
    }
    return { kind: 'verdict', decision: 'ask', reason: gate.reasons.join(' · ') }
  } catch (error) {
    if (error instanceof JevRequestError && (error.status === 401 || error.status === 403)) {
      return { kind: 'auth-rejected', status: error.status }
    }
    return { kind: 'none' }
  }
}

async function main(): Promise<void> {
  const input = readHookInput()
  if (input === null) passThrough()
  const { command, cwd } = input as HookInput

  for (const safe of OBVIOUSLY_SAFE) {
    if (safe.test(command)) passThrough()
  }
  for (const { pattern, why } of NEVER_SILENTLY) {
    if (pattern.test(command)) {
      appendGateRecord(cwd, command, 'local-rule', 'ask', null)
      emit('ask', t('localRule', { why: t(why) }))
      return
    }
  }

  const apiKey = await resolveApiKey()
  if (apiKey === null) passThrough()

  const context = repoContext(cwd)
  const key = cacheKey(command, context)
  const cache = readCache()
  const hit = cache[key]
  if (hit !== undefined) {
    appendGateRecord(cwd, command, 'cache', hit.decision, null)
    emit(hit.decision, t('cached', { reason: hit.reason }))
    return
  }

  const jevStartedAt = Date.now()
  const outcome = await askJev(apiKey as string, command, context)
  const jevLatencyMs = Date.now() - jevStartedAt

  if (outcome.kind === 'none') passThrough()

  if (outcome.kind === 'auth-rejected') {
    if (!readAuthWarned()) {
      writeAuthWarned(true)
      passThroughWithNotice(t('authRejected', { status: String(outcome.status) }))
    }
    passThrough()
  }

  // Llegar aca es una respuesta valida: si el ultimo aviso de rechazo
  // seguia en pie, la llave ya funciona de nuevo, y el proximo rechazo
  // merece avisarse otra vez.
  if (readAuthWarned()) writeAuthWarned(false)

  const resolved = outcome as { kind: 'verdict'; decision: Decision; reason: string }
  cache[key] = { decision: resolved.decision, reason: resolved.reason, at: Date.now() }
  writeCache(cache)
  appendGateRecord(cwd, command, 'jev', resolved.decision, jevLatencyMs)
  emit(resolved.decision, resolved.reason)
}

await main()
