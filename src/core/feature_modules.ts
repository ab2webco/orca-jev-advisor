// Feature modules (odd/tasks/feature-modules.md): the one registry of the
// features the owner can turn off so they cost nothing -- no hook process,
// no Jev call, no worker job. For each module it says which settings.json
// hook entries, which features of the shared mod copy and which worker jobs
// it owns, and which existing per-feature modes sit under its switch. The
// installer, the worker, the mod and the panel all read this list; adding a
// module is one entry.
//
// The state lives in `<configDir>/feature-modules.json` (FEATURE_MODULES_FILE),
// beside the other plain-file mirrors (mod-skills-config.json,
// deny-tier-config.json): the worker writes it from the panel, and every
// process that needs it reads the file directly. Its shape is
// `{ "modules": { "<id>": "off" | "shadow" | "active" } }`.
//
// Three states per module:
//   off     -- nothing runs: its hooks are uninstalled, its mod features
//              return before any Jev call, its worker jobs never start.
//   shadow  -- the module runs but only measures: its existing modes are
//              capped at their measure value. Offered only by a module that
//              already has a measure mode; that mode IS its shadow, so no
//              second shadow switch exists anywhere. A module that only
//              measures (verify-done) offers off and shadow, no active, and
//              has no existing mode: its shadow is its own one switch.
//   active  -- the module's own existing modes decide, exactly as before
//              this file existed.
// `off` is a top state in front of the existing modes, never a parallel
// boolean: effectiveMode combines the two into the one mode a feature runs.
//
// Upgrade keeps behaviour: a missing, unreadable or malformed file, and any
// unknown or wrong-typed field, read as each module's default, and every
// module that existed before 0.8.0 defaults to `active`. verify-done, new in
// 0.8.0, has no earlier behaviour to keep and defaults to `shadow`: its week
// of measurement is the point (odd/tasks/verify-done-module.md).
//
// Pure: no I/O and no node: import, so the mod sandbox can load it too.

/** The module state file, in the plugin config directory (src/core/paths.ts resolveConfigDir). */
export const FEATURE_MODULES_FILE = "feature-modules.json";

export type ModuleId = "gate" | "model-router" | "steward" | "skill-selection" | "board" | "verify-done";

export const MODULE_IDS: readonly ModuleId[] = ["gate", "model-router", "steward", "skill-selection", "board", "verify-done"];

export type ModuleState = "off" | "shadow" | "active";

export const MODULE_STATES: readonly ModuleState[] = ["off", "shadow", "active"];

/** The scale every existing per-feature mode maps onto: the router's, the steward's and the work kind's own modes already are this. */
export type FeatureMode = "off" | "measure" | "active";

export type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionDenied";

/** One settings.json hook entry install-claude-integration.mjs manages (hookSpecs): the event, the matcher group and the script under adapters/claude/. */
export interface HookEntry {
  readonly event: HookEvent;
  readonly matcher: string;
  readonly script: string;
}

export type ModFeatureId = "router-tier" | "router-subagent" | "subagent-status" | "turn-usage" | "steward" | "skill-selection" | "tool-selection" | "verify-done";

/** A feature of the shared mod copy (adapters/claude/mod-skills/hooks/index.ts) and the engine hooks it runs from. */
export interface ModFeature {
  readonly id: ModFeatureId;
  readonly hooks: readonly string[];
  readonly jev: boolean;
}

export type WorkerJobId =
  | "measurements-summary"
  | "model-measurements"
  | "gate-authorizations"
  | "account-quota"
  | "router-status"
  | "model-docs-check"
  | "consumption-summary"
  | "activity-summary"
  | "models-catalog"
  | "mod-skills-status"
  | "deny-tier-status"
  | "trusted-programs-status"
  | "gate-defaults"
  | "mod-skills-config-request"
  | "router-config-request"
  | "deny-tier-config-request"
  | "gate-authorization-forget-request"
  | "trusted-program-request"
  | "models-request"
  | "board-agent-status"
  | "board-worktree-created"
  | "board-worktree-removed";

/**
 * When adapters/orca/main.mjs runs a job: once at activation, on each turn
 * of the request poll loop (it attends a panel request, if any), on one of
 * the four intervals, or on an Orca event.
 */
export type WorkerTrigger =
  | "activation"
  | "poll"
  | "interval-15s"
  | "interval-account-quota-10min"
  | "interval-consumption-10min"
  | "interval-activity-10min"
  | "agent.status.changed"
  | "worktree.created"
  | "worktree.removed";

/** One worker job: its function in main.mjs (or models-worker.mjs), when it runs and the node sidecar it spawns, null when none. */
export interface WorkerJob {
  readonly id: WorkerJobId;
  readonly fn: string;
  readonly triggers: readonly WorkerTrigger[];
  readonly sidecar: string | null;
  /**
   * T4b: what the job writes is read only by a panel (nothing in the worker,
   * the gate or the router decides from it). It still runs once at
   * activation, but its interval ticks run only while a panel is open. A job
   * that feeds a decision, or that spawns nothing, is not marked.
   */
  readonly panelOnly?: true;
}

/** An existing per-feature switch the module's state sits in front of, and where it is stored. `shadowValue` is the value that is the module's shadow, null when the switch has no measure value. */
export interface ModeSource {
  readonly name: string;
  readonly values: readonly string[];
  readonly defaultValue: string;
  readonly store: string;
  readonly shadowValue: string | null;
}

export interface FeatureModule {
  readonly id: ModuleId;
  readonly states: readonly ModuleState[];
  readonly defaultState: ModuleState;
  readonly hooks: readonly HookEntry[];
  readonly modFeatures: readonly ModFeature[];
  readonly workerJobs: readonly WorkerJob[];
  readonly modes: readonly ModeSource[];
}

const FILE_TOOLS_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const ROUTER_OPTIONS = "account settings.json pluginConfigs[\"orca-jev-mod-skills@skills-dir\"].options";

// panelOnly (T4b) classification, from who reads each interval job's output:
//   panel only    measurements-summary, gate-authorizations, router-status,
//                 consumption-summary, activity-summary (storage keys only
//                 config.html and board.html read).
//   decision      model-measurements: when the readiness verdict flips it
//                 re-mirrors the catalog whose `ready` flag the Agent hook
//                 reads (models-worker.mjs publishModelMeasurements);
//                 account-quota: writes quota.json, which the router mod
//                 reads for quota pressure (mod-skills hooks/index.ts).
//   no process    model-docs-check: a daily fetch inside the worker, no
//                 sidecar, so gating it would save nothing.
// Jobs more than one module owns: each owner lists the same entry, and the
// job runs while any of them is on (workerJobsOn).
const MEASUREMENTS_SUMMARY: WorkerJob = { id: "measurements-summary", fn: "publishMeasurementsSummary", triggers: ["activation", "interval-15s"], sidecar: "read-measurements.mjs", panelOnly: true };
// Also refreshed on a panel request (attendModelRouterStatusRefresh), which spawns the same sidecar.
const ROUTER_STATUS: WorkerJob = { id: "router-status", fn: "publishModelRouterStatus", triggers: ["activation", "poll", "interval-account-quota-10min"], sidecar: "install-claude-integration.mjs", panelOnly: true };
const ROUTER_CONFIG_REQUEST: WorkerJob = { id: "router-config-request", fn: "attendModelRouterConfigRequest", triggers: ["poll"], sidecar: "install-claude-integration.mjs" };
const CONSUMPTION_SUMMARY: WorkerJob = { id: "consumption-summary", fn: "publishConsumptionSummary", triggers: ["activation", "interval-consumption-10min"], sidecar: "read-consumption.mjs", panelOnly: true };
const ACTIVITY_SUMMARY: WorkerJob = { id: "activity-summary", fn: "publishActivitySummary", triggers: ["activation", "interval-activity-10min"], sidecar: "read-activity.mjs", panelOnly: true };

export const FEATURE_MODULES: readonly FeatureModule[] = [
  {
    id: "gate",
    states: ["off", "active"],
    defaultState: "active",
    hooks: [
      { event: "PreToolUse", matcher: "Bash", script: "gate-bash.ts" },
      { event: "PostToolUse", matcher: "Bash", script: "gate-outcome.ts" },
      { event: "PermissionDenied", matcher: "Bash", script: "gate-outcome.ts" },
      { event: "PostToolUseFailure", matcher: "Bash", script: "gate-outcome.ts" },
      { event: "PreToolUse", matcher: FILE_TOOLS_MATCHER, script: "gate-files.mjs" },
    ],
    modFeatures: [],
    workerJobs: [
      MEASUREMENTS_SUMMARY,
      { id: "gate-authorizations", fn: "publishGateAuthorizations", triggers: ["activation", "interval-15s"], sidecar: "gate-authorizations.mjs", panelOnly: true },
      ACTIVITY_SUMMARY,
      { id: "deny-tier-status", fn: "publishDenyTierStatus", triggers: ["activation"], sidecar: "write-secret-mirror.mjs" },
      { id: "trusted-programs-status", fn: "publishTrustedPrograms", triggers: ["activation"], sidecar: null },
      { id: "gate-defaults", fn: "publishGateDefaults", triggers: ["activation"], sidecar: null },
      { id: "deny-tier-config-request", fn: "attendDenyTierConfigRequest", triggers: ["poll"], sidecar: "write-secret-mirror.mjs" },
      { id: "gate-authorization-forget-request", fn: "attendGateAuthorizationForgetRequest", triggers: ["poll"], sidecar: "gate-authorizations.mjs" },
      { id: "trusted-program-request", fn: "attendTrustedProgramRequest", triggers: ["poll"], sidecar: "write-secret-mirror.mjs" },
    ],
    modes: [
      { name: "deny-tier switches (9, src/core/deny_tier_config.ts DENY_TOGGLE_KEYS)", values: ["deny", "ask"], defaultValue: "deny", store: "<configDir>/deny-tier-config.json", shadowValue: null },
      { name: "queue mode", values: ["off", "on"], defaultValue: "off", store: "<configDir>/queue-mode.json (Orca storage queueMode)", shadowValue: null },
      { name: "trusted programs", values: ["list"], defaultValue: "list", store: "<configDir>/trusted-programs.json", shadowValue: null },
    ],
  },
  {
    id: "model-router",
    states: MODULE_STATES,
    defaultState: "active",
    hooks: [
      { event: "PreToolUse", matcher: "Agent", script: "agent-model.ts" },
      { event: "PostToolUse", matcher: "Agent", script: "agent-model.ts" },
      { event: "PostToolUseFailure", matcher: "Agent", script: "agent-model.ts" },
    ],
    modFeatures: [
      { id: "router-tier", hooks: ["prompt.submit", "turn.step"], jev: true },
      { id: "router-subagent", hooks: ["agent.spawn", "turn.step", "tool.call"], jev: true },
      { id: "subagent-status", hooks: ["agent.spawn", "turn.step", "turn.complete", "session.start", "ui.render", "tool.call"], jev: false },
      { id: "turn-usage", hooks: ["turn.step", "tool.call"], jev: false },
    ],
    workerJobs: [
      { id: "model-measurements", fn: "publishModelMeasurements", triggers: ["activation", "interval-15s"], sidecar: "read-model-measurements.mjs" },
      { id: "account-quota", fn: "mirrorAccountQuota", triggers: ["activation", "interval-account-quota-10min"], sidecar: "write-secret-mirror.mjs" },
      ROUTER_STATUS,
      { id: "model-docs-check", fn: "refreshModelDocs", triggers: ["activation", "interval-account-quota-10min"], sidecar: null },
      CONSUMPTION_SUMMARY,
      ACTIVITY_SUMMARY,
      { id: "models-catalog", fn: "seedModelsIfEmpty, mirrorModels, publishModelsSeedNotice", triggers: ["activation"], sidecar: "write-secret-mirror.mjs" },
      ROUTER_CONFIG_REQUEST,
      { id: "models-request", fn: "attendModelsMirrorRequest, attendModelsSeedRequest", triggers: ["poll"], sidecar: "write-secret-mirror.mjs" },
    ],
    modes: [
      { name: "routerMode", values: ["off", "measure", "active"], defaultValue: "measure", store: `${ROUTER_OPTIONS}.routerMode`, shadowValue: "measure" },
      { name: "legacy model switch (agent-model hook)", values: ["measurement", "active"], defaultValue: "measurement", store: "Orca storage modelsConfig.active, mirrored to <configDir>/models-catalog.json .active", shadowValue: "measurement" },
      { name: "workKindMode", values: ["off", "measure", "active"], defaultValue: "measure", store: `${ROUTER_OPTIONS}.workKindMode`, shadowValue: "measure" },
      { name: "explicit models", values: ["judge", "keep"], defaultValue: "judge", store: "<configDir>/explicit-models.json (Orca storage explicitModels)", shadowValue: null },
    ],
  },
  {
    id: "steward",
    states: MODULE_STATES,
    defaultState: "active",
    hooks: [],
    modFeatures: [{ id: "steward", hooks: ["prompt.submit", "turn.start", "turn.complete"], jev: true }],
    workerJobs: [ROUTER_STATUS, CONSUMPTION_SUMMARY, ROUTER_CONFIG_REQUEST],
    modes: [
      { name: "stewardMode", values: ["off", "measure", "active"], defaultValue: "measure", store: `${ROUTER_OPTIONS}.stewardMode`, shadowValue: "measure" },
      { name: "stewardSoftMode (400k tier)", values: ["measure", "active"], defaultValue: "measure", store: `${ROUTER_OPTIONS}.stewardSoftMode`, shadowValue: "measure" },
    ],
  },
  {
    id: "skill-selection",
    states: MODULE_STATES,
    defaultState: "active",
    hooks: [],
    modFeatures: [
      { id: "skill-selection", hooks: ["prompt.submit", "prompt.attachment", "skill.prompt"], jev: true },
      { id: "tool-selection", hooks: ["prompt.submit", "tool.call"], jev: true },
    ],
    workerJobs: [
      MEASUREMENTS_SUMMARY,
      { id: "mod-skills-status", fn: "publishModSkillsStatus", triggers: ["activation"], sidecar: "write-secret-mirror.mjs" },
      { id: "mod-skills-config-request", fn: "attendModSkillsConfigRequest", triggers: ["poll"], sidecar: "write-secret-mirror.mjs" },
    ],
    modes: [
      { name: "active (skills)", values: ["measurement", "active"], defaultValue: "measurement", store: "<configDir>/mod-skills-config.json .active", shadowValue: "measurement" },
      { name: "activeTools (tools)", values: ["measurement", "active"], defaultValue: "measurement", store: "<configDir>/mod-skills-config.json .activeTools", shadowValue: "measurement" },
    ],
  },
  {
    id: "board",
    states: ["off", "active"],
    defaultState: "active",
    hooks: [],
    modFeatures: [],
    workerJobs: [
      // Its 30 s cache of `orca worktree list` and `orca repo list` runs inside this handler.
      { id: "board-agent-status", fn: "onAgentStatusChanged", triggers: ["agent.status.changed"], sidecar: null },
      { id: "board-worktree-created", fn: "onWorktreeCreated", triggers: ["worktree.created"], sidecar: null },
      { id: "board-worktree-removed", fn: "onWorktreeRemoved", triggers: ["worktree.removed"], sidecar: null },
    ],
    modes: [],
  },
  {
    // odd/tasks/verify-done-module.md: only measures. turn.complete can only
    // observe, so a blocking state would need a Stop hook this repo does not
    // install; until the measurement decides one, there is no active.
    id: "verify-done",
    states: ["off", "shadow"],
    defaultState: "shadow",
    hooks: [],
    modFeatures: [{ id: "verify-done", hooks: ["turn.complete"], jev: true }],
    workerJobs: [],
    modes: [],
  },
];

export type FeatureModules = { readonly [K in ModuleId]: ModuleState };

export const DEFAULT_FEATURE_MODULES: FeatureModules = {
  gate: "active",
  "model-router": "active",
  steward: "active",
  "skill-selection": "active",
  board: "active",
  "verify-done": "shadow",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registryEntry(id: ModuleId): FeatureModule {
  const entry = FEATURE_MODULES.find((module) => module.id === id);
  if (entry === undefined) throw new Error(`feature module ${id} is missing from FEATURE_MODULES`);
  return entry;
}

/** One module's state from the file's value: a state the module offers, else its default. */
function stateOf(id: ModuleId, value: unknown): ModuleState {
  const entry = registryEntry(id);
  return typeof value === "string" && (entry.states as readonly string[]).includes(value) ? (value as ModuleState) : entry.defaultState;
}

/**
 * Parses `<configDir>/feature-modules.json`'s content. Never throws: a missing
 * file (pass `""`), malformed JSON or a non-object payload give the defaults,
 * and each module falls back to its own default alone when its value is
 * missing, wrong-typed or a state it does not offer. Unknown ids are ignored.
 */
export function parseFeatureModules(content: string): FeatureModules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return DEFAULT_FEATURE_MODULES;
  }
  if (!isRecord(parsed) || !isRecord(parsed.modules)) return DEFAULT_FEATURE_MODULES;
  const stored = parsed.modules;
  const read = (id: ModuleId): unknown => (Object.hasOwn(stored, id) ? stored[id] : undefined);
  return {
    gate: stateOf("gate", read("gate")),
    "model-router": stateOf("model-router", read("model-router")),
    steward: stateOf("steward", read("steward")),
    "skill-selection": stateOf("skill-selection", read("skill-selection")),
    board: stateOf("board", read("board")),
    "verify-done": stateOf("verify-done", read("verify-done")),
  };
}

export type FeatureModulesInput =
  | { readonly ok: true; readonly modules: FeatureModules }
  | { readonly ok: false; readonly detail: string };

/**
 * The strict reader of a write request (the panel's switch, through the
 * worker's feature-modules-save sidecar). parseFeatureModules is tolerant on
 * purpose, since a bad file must read as today's behaviour; a bad request must
 * not be written at all, so this refuses anything but every known module with
 * a state it offers, and unknown ids. Never throws.
 */
export function validateFeatureModulesInput(value: unknown): FeatureModulesInput {
  if (!isRecord(value) || !isRecord(value.modules)) return { ok: false, detail: "expected { modules: { <id>: state } }." };
  const given = value.modules;
  const unknown = Object.keys(given).filter((key) => !(MODULE_IDS as readonly string[]).includes(key));
  if (unknown.length > 0) return { ok: false, detail: `unknown module: ${unknown.join(", ").slice(0, 40)}.` };
  const modules: Record<string, ModuleState> = {};
  for (const id of MODULE_IDS) {
    const state = Object.hasOwn(given, id) ? given[id] : undefined;
    if (typeof state !== "string" || !(registryEntry(id).states as readonly string[]).includes(state)) {
      return { ok: false, detail: `${id} needs one of: ${registryEntry(id).states.join(", ")}.` };
    }
    modules[id] = state as ModuleState;
  }
  return { ok: true, modules: modules as FeatureModules };
}

export function moduleState(modules: FeatureModules, id: ModuleId): ModuleState {
  return modules[id];
}

/**
 * The mode a feature runs in: its module's state in front of the feature's
 * own existing mode. `off` gives off whatever the own mode says (zero Jev
 * calls); `shadow` caps the own mode at measure and never turns on a feature
 * whose own mode is off; `active` leaves the own mode to decide.
 */
export function effectiveMode(state: ModuleState, own: FeatureMode): FeatureMode {
  if (state === "off") return "off";
  if (state === "shadow") return own === "active" ? "measure" : own;
  return own;
}

/** A boolean on/active switch (the skills mod's `active`/`activeTools`, the legacy model switch) on the FeatureMode scale: off means measurement, not off. */
export function switchMode(active: boolean): "measure" | "active" {
  return active ? "active" : "measure";
}

function modulesOn(modules: FeatureModules): readonly FeatureModule[] {
  return FEATURE_MODULES.filter((module) => modules[module.id] !== "off");
}

/** The settings.json hook entries that should be installed: those of every module that is not off. */
export function hooksFor(modules: FeatureModules): readonly HookEntry[] {
  return modulesOn(modules).flatMap((module) => module.hooks);
}

/** The mod copy's features that should run. */
export function modFeaturesOn(modules: FeatureModules): readonly ModFeatureId[] {
  return modulesOn(modules).flatMap((module) => module.modFeatures.map((feature) => feature.id));
}

/** The worker jobs that should run, each once: a shared job runs while any of its owners is on. */
export function workerJobsOn(modules: FeatureModules): readonly WorkerJobId[] {
  return [...new Set(modulesOn(modules).flatMap((module) => module.workerJobs.map((job) => job.id)))];
}

/** The jobs that run on `trigger`, whichever module owns them. A timer or an event subscription is shared by all of them. */
export function workerJobsFor(trigger: WorkerTrigger): readonly WorkerJobId[] {
  return [...new Set(FEATURE_MODULES.flatMap((module) => module.workerJobs.filter((job) => job.triggers.includes(trigger)).map((job) => job.id)))];
}

/** Whether `trigger` has anything left to do: at least one of its jobs is on. A timer is cleared only when this is false, that is when every module using it is off. */
export function workerTriggerOn(modules: FeatureModules, trigger: WorkerTrigger): boolean {
  const on = new Set(workerJobsOn(modules));
  return workerJobsFor(trigger).some((id) => on.has(id));
}

/** Whether the job's interval ticks run only while a panel is open (see WorkerJob.panelOnly). */
export function workerJobIsPanelOnly(id: WorkerJobId): boolean {
  return FEATURE_MODULES.some((module) => module.workerJobs.some((job) => job.id === id && job.panelOnly === true));
}

/**
 * Whether `trigger` needs its timer or subscription right now: at least one
 * of its jobs is on, and either it is not panel-only or a panel is open. A
 * timer of panel-only jobs is cleared when the last panel goes away, so the
 * worker has nothing left to wake for.
 */
export function workerTriggerWanted(modules: FeatureModules, trigger: WorkerTrigger, panelOpen: boolean): boolean {
  const on = new Set(workerJobsOn(modules));
  return workerJobsFor(trigger).some((id) => on.has(id) && (panelOpen || !workerJobIsPanelOnly(id)));
}

/** Whether the mod copy under ~/.claude/skills must stay installed: any of its features is on. */
export function modCopyNeeded(modules: FeatureModules): boolean {
  return modFeaturesOn(modules).length > 0;
}
