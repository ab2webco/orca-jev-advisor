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
