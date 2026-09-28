/**
 * Queue mode: when a person must approve and nobody is watching,
 * queue the action and let the agent continue instead of blocking.
 * Default: false (ask now).
 */

export function parseQueueMode (json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false
  const obj = json as Record<string, unknown>
  return typeof obj.enabled === 'boolean' ? obj.enabled : false
}

export const QUEUE_MODE_CONFIG_KEY = 'queueMode'

/** The mirror's file name inside the config dir -- one constant for the writer (write-secret-mirror.mjs) and the reader (gate-bash.ts). */
export const QUEUE_MODE_MIRROR_FILE = 'queue-mode.json'
