#!/usr/bin/env node
/**
 * Records what the person decided after the gate stopped them.
 *
 * The gate answers a PreToolUse hook and never learns what happened next: a
 * prompt it raised might have been waved through in a second or refused
 * outright, and every threshold in this plugin was calibrated against a
 * corpus written by hand because that answer was never captured.
 *
 * Claude Code reports it through three later hooks, all carrying the same
 * `tool_use_id` the gate saw:
 *
 *   PostToolUse        the command ran and succeeded -> the stop was not worth making
 *   PostToolUseFailure the command ran and failed     -> still approved: they said yes
 *   PermissionDenied   it did not run                 -> the stop earned its interruption
 *
 * PostToolUseFailure is still an approval, not a rejection: the question
 * this log answers is "was interrupting the person worth it", and they
 * already answered it by letting the command run. Whether the command then
 * succeeded or failed on its own is the command's business, never the
 * gate's -- a failed command is not a rejected one.
 *
 * This process is that recorder and nothing else. It never decides anything,
 * never emits a permission verdict, and never delays a tool: it appends one
 * line and exits. Anything that goes wrong is swallowed, because a recorder
 * that can break a command is not worth having.
 *
 * Usage: registered by install-claude-integration.mjs on PostToolUse,
 * PostToolUseFailure and PermissionDenied. Reads the hook payload on stdin,
 * writes nothing to stdout.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildApprovalOutcomeRecord, parsePendingToolUseIds, serializeApprovalRecord } from '../../src/core/approval_record.ts'
import type { ApprovalOutcome } from '../../src/core/approval_record.ts'
import { normalizePlatform, resolveCacheDir } from '../../src/core/paths.ts'

const PLATFORM = normalizePlatform(process.platform)
const CACHE_DIR = resolveCacheDir(PLATFORM, {
  home: homedir(),
  appDataDir: process.env.APPDATA,
  localAppDataDir: process.env.LOCALAPPDATA,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
})
const OUTCOMES_PATH = join(CACHE_DIR, 'gate-approvals.jsonl')

/** Exits silently. This hook must never be the reason a command fails or stalls. */
function done(): never {
  process.exit(0)
}

/**
 * Which answer this event represents, or null when it is neither.
 *
 * Only Bash is recorded. The gate judges nothing else, so an outcome for a
 * file edit or a web fetch would be a row that can never be joined to a
 * question -- noise in a file whose whole purpose is to be counted.
 */
/**
 * Whether the gate actually stopped for this tool_use_id -- i.e. whether a
 * gate-pending record for it already sits in the log. An outcome with no
 * matching pending answers no question the gate ever asked: most Bash
 * commands are never stopped, so writing an outcome for every one of them
 * buried the few real calibration answers (measured: 2697 outcomes, 15
 * pendings, 11 joinable -- a 245:1 ratio of noise to signal).
 *
 * Best-effort like everything else here: an unreadable log answers false
 * (nothing to join, so nothing to write), never a throw.
 */
function hasPendingApproval(toolUseId: string): boolean {
  let raw: string
  try {
    raw = readFileSync(OUTCOMES_PATH, 'utf8')
  } catch {
    return false
  }
  return parsePendingToolUseIds(raw).has(toolUseId)
}

function outcomeFor(event: string, toolName: unknown): ApprovalOutcome | null {
  if (toolName !== 'Bash') return null
  if (event === 'PostToolUse') return 'approved'
  // The command ran -- the person already approved it -- and then failed on
  // its own. That failure is the command's business, not the gate's: the
  // question this log answers is "was interrupting the person worth it",
  // and they said yes. A failed command is not a rejected one.
  if (event === 'PostToolUseFailure') return 'approved'
  if (event === 'PermissionDenied') return 'rejected'
  return null
}

function main(): void {
  let raw: string
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    done()
  }
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) done()
    parsed = value as Record<string, unknown>
  } catch {
    done()
  }

  const event = parsed['hook_event_name']
  const toolUseId = parsed['tool_use_id']
  if (typeof event !== 'string' || typeof toolUseId !== 'string' || toolUseId.length === 0) done()

  const outcome = outcomeFor(event, parsed['tool_name'])
  if (outcome === null) done()

  // Only a joinable outcome answers a real question -- see hasPendingApproval.
  if (!hasPendingApproval(toolUseId)) done()

  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    appendFileSync(
      OUTCOMES_PATH,
      serializeApprovalRecord(
        buildApprovalOutcomeRecord({ toolUseId, at: new Date().toISOString(), outcome }),
      ),
    )
  } catch {
    // Best effort, by design: a log that cannot be written is never a reason
    // to fail a command that already ran.
  }
  done()
}

main()
