// gate-bash.ts's three configurable deny-tier switches: `rm -rf /` (and
// `~`/`$HOME`), `DROP`/`TRUNCATE TABLE`/`DATABASE`/`SCHEMA`, and
// `terraform`/`tofu destroy`. See NEVER_SILENTLY in adapters/claude/
// gate-bash.ts for the principle these three -- and only these three --
// exist for: blast radius beyond the repository AND beyond recovery.
// Everything else NEVER_SILENTLY catches stays `ask`, deliberately, because
// a person is right there to answer it.
//
// This is the same "worker writes a plain file, a process with no channel
// into Orca's `storage` reads it directly" shape src/core/mod_skills_config.ts
// already established for the skill/tool selection switches (see that
// file's own module note, and T10 in odd/tasks/panel-worker-wakeup.md).
//
// It deliberately does NOT share mod_skills_config.ts's fail-open contract.
// mod_skills_config.ts defaults to `false` (off) on any missing or malformed
// config, because leaving an experimental feature off is always the safe
// choice. Here the opposite is true: `false` (a rule downgraded to `ask`)
// is the one state that must never be reached by accident. A missing file
// (nobody has touched this yet), an unreadable one, or a malformed one are
// all read the exact same way a brand-new install reads: every switch
// defaults to `true`, still denying. A config that cannot be read is not
// permission to stop protecting.
//
// Turning a switch off never means "allow" -- adapters/claude/gate-bash.ts
// downgrades a disabled rule to `ask`, the same question a human already
// answers for every other NEVER_SILENTLY rule. Nothing here ever becomes
// silent.

export interface DenyTierSwitches {
  readonly denyRmRf: boolean;
  readonly denyDropTable: boolean;
  readonly denyTerraformDestroy: boolean;
}

// On (denying) by default at every layer -- see the module note above for
// why this is the opposite of DEFAULT_MOD_SKILLS_SWITCHES.
export const DEFAULT_DENY_TIER_SWITCHES: DenyTierSwitches = {
  denyRmRf: true,
  denyDropTable: true,
  denyTerraformDestroy: true,
};

/**
 * Parses `<configDir>/deny-tier-config.json`'s content. Never throws: a
 * missing file (pass `""`), malformed JSON, a non-object payload, or a
 * field of the wrong type all fail CLOSED to `true` (still denying) for the
 * affected field -- one field being wrong-typed never turns another field's
 * protection off, and never turns any field into `false` by accident.
 */
export function parseDenyTierConfig(content: string): DenyTierSwitches {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return DEFAULT_DENY_TIER_SWITCHES;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_DENY_TIER_SWITCHES;

  const record = parsed as Record<string, unknown>;
  const denyRmRf = typeof record.denyRmRf === "boolean" ? record.denyRmRf : true;
  const denyDropTable = typeof record.denyDropTable === "boolean" ? record.denyDropTable : true;
  const denyTerraformDestroy = typeof record.denyTerraformDestroy === "boolean" ? record.denyTerraformDestroy : true;
  return { denyRmRf, denyDropTable, denyTerraformDestroy };
}
