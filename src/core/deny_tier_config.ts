// gate-bash.ts's deny-tier switches: one per NEVER_SILENTLY rule in
// adapters/claude/gate-bash.ts, nine in all (DENY_TOGGLE_KEYS below), and
// every one denies by default (DEFAULT_DENY_TIER_SWITCHES is all `true`).
// `denyResetClean` covers every way of discarding uncommitted work the gate
// recognises: `git reset --hard`, `git clean -f`, and the working-tree
// forms of `git checkout` and `git restore` (src/core/git_discard.ts). See
// NEVER_SILENTLY for why deny, not ask, is the default.
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
// downgrades a disabled rule to `ask`, a question the person answers.
// Nothing here ever becomes silent.

/**
 * One switch per tier-1b rule. Every one of them denies by default.
 *
 * The defaults were the other way round for exactly one release, and the
 * numbers overturned it: across the real approvals log, 3103 commands were
 * approved and 1 was refused, while 5 of 16 questions were never answered at
 * all. A question whose answer is yes 99.97% of the time is not buying
 * safety, it is buying the person's attention -- and Claude Code's dialog
 * opens with the cursor on "Yes", so a reflex Enter defeats it anyway.
 *
 * `deny` refuses the call and hands the reason to the model, which then picks
 * another approach (`claude-code.d.ts`: "Refuses the call; the model receives
 * the text as the reason"). `ask` stops the human and waits. Running with
 * permission prompts turned off is a deliberate choice that agents should not
 * sit waiting on a person, and an `ask` quietly puts that waiting back.
 *
 * The person is never blocked -- only the agent is. Anyone can still run the
 * command themselves in a terminal.
 */
export const DENY_TOGGLE_KEYS = [
  "denyForcePush",
  "denyPushProtected",
  "denyRmRf",
  "denyResetClean",
  "denyDropTable",
  "denyKubectlDelete",
  "denyTerraformApply",
  "denyTerraformDestroy",
  "denyCurlPipeShell",
] as const;

export type DenyToggleKey = (typeof DENY_TOGGLE_KEYS)[number];
export type DenyTierSwitches = { readonly [K in DenyToggleKey]: boolean };

/** Denying at every layer. Built from the key list so a new rule cannot be
 *  added without a default, and cannot silently default to off. */
export const DEFAULT_DENY_TIER_SWITCHES: DenyTierSwitches = Object.freeze(
  Object.fromEntries(DENY_TOGGLE_KEYS.map((key) => [key, true])),
) as DenyTierSwitches;

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
  return Object.fromEntries(
    DENY_TOGGLE_KEYS.map((key) => [key, typeof record[key] === "boolean" ? record[key] : true]),
  ) as DenyTierSwitches;
}
