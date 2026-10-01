// When the worker should install the Claude Code integration again on its
// own: an Orca account added after "Configure" has no hooks, and a plugin
// upgrade leaves hooks pointing at the old root. Pure -- the worker feeds it
// the installer's `status` and remembers the returned signature.

/** How often the worker looks at all: the look spawns the installer. */
export const RESCAN_INTERVAL_MS = 60_000;

export type RescanFamily = {
  readonly installed: boolean;
  readonly pathMatches: boolean;
};

export type RescanTarget = {
  readonly id: string;
  readonly hook: RescanFamily;
  readonly outcomeHook: RescanFamily;
  readonly agentModelHook: RescanFamily;
  /** 0.6.17 T2: the file tools' guard. */
  readonly fileGuardHook: RescanFamily;
};

export type RescanStatus = {
  readonly ok: boolean;
  readonly targets: readonly RescanTarget[];
};

export type RescanDecision = {
  readonly install: boolean;
  /** What is still unresolved (null when nothing); the worker passes it back next time. */
  readonly signature: string | null;
};

export function isRescanDue(now: number, lastCheckedAt: number | null): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= RESCAN_INTERVAL_MS;
}

function families(target: RescanTarget): readonly RescanFamily[] {
  return [target.hook, target.outcomeHook, target.agentModelHook, target.fileGuardHook];
}

/**
 * Install only when Configure has been done before (some hook is installed
 * somewhere) and some target is missing a hook or has one on a stale path.
 * An unresolved set is tried once: if the install cannot fix it (an
 * unwritable account), the same set is not retried every minute.
 */
export function decideRescanInstall(status: RescanStatus, lastSignature: string | null): RescanDecision {
  if (!status.ok) return { install: false, signature: lastSignature };
  const configured = status.targets.some((target) => families(target).some((family) => family.installed));
  if (!configured) return { install: false, signature: null };

  const unresolved: string[] = [];
  for (const target of status.targets) {
    if (families(target).some((family) => !family.installed)) unresolved.push(`${target.id}:missing`);
    else if (families(target).some((family) => !family.pathMatches)) unresolved.push(`${target.id}:stale-path`);
  }
  if (unresolved.length === 0) return { install: false, signature: null };
  const signature = unresolved.sort().join(",");
  return { install: signature !== lastSignature, signature };
}
