// The feature-module registry (odd/tasks/feature-modules.md, T1): one pure
// list of the modules the owner can turn off, what each owns (settings.json
// hook entries, features of the shared mod copy, worker jobs, existing
// modes), and the parser of `<configDir>/feature-modules.json`.
//
// The installer has no exported list of its hook entries (hookSpecs is
// private to install-claude-integration.mjs), so the ownership test checks
// the registry against INSTALLED_HOOKS below, a fixed list mirroring the
// installer's header, and checks that list against the `{ event, matcher,
// owner: hookOwner('<script>' ...` rows of hookSpecs read from the
// installer's own source, so a hook added there without an owner here fails.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_FEATURE_MODULES,
  FEATURE_MODULES,
  FEATURE_MODULES_FILE,
  MODULE_IDS,
  effectiveMode,
  hooksFor,
  modCopyNeeded,
  modFeaturesOn,
  moduleState,
  parseFeatureModules,
  switchMode,
  validateFeatureModulesInput,
  workerJobsFor,
  workerJobIsPanelOnly,
  workerJobsOn,
  workerTriggerOn,
  workerTriggerWanted,
} from "./feature_modules.ts";
import type { FeatureMode, FeatureModules, HookEntry, ModuleId, ModuleState, WorkerTrigger } from "./feature_modules.ts";

/** The eight entries install-claude-integration.mjs installs today (its header and hookSpecs). */
const INSTALLED_HOOKS: readonly HookEntry[] = [
  { event: "PreToolUse", matcher: "Bash", script: "gate-bash.ts" },
  { event: "PostToolUse", matcher: "Bash", script: "gate-outcome.ts" },
  { event: "PermissionDenied", matcher: "Bash", script: "gate-outcome.ts" },
  { event: "PostToolUseFailure", matcher: "Bash", script: "gate-outcome.ts" },
  { event: "PreToolUse", matcher: "Agent", script: "agent-model.ts" },
  { event: "PostToolUse", matcher: "Agent", script: "agent-model.ts" },
  { event: "PostToolUseFailure", matcher: "Agent", script: "agent-model.ts" },
  { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", script: "gate-files.mjs" },
];

const hookKey = (hook: HookEntry): string => `${hook.event} ${hook.matcher} ${hook.script}`;

function withStates(states: Partial<Record<ModuleId, ModuleState>>): FeatureModules {
  return { ...DEFAULT_FEATURE_MODULES, ...states };
}

function fileWith(modules: unknown): string {
  return JSON.stringify({ modules });
}

/** hookSpecs' rows, read from the installer's source, as hookKey strings: event, matcher (FILE_TOOLS_MATCHER resolved) and the script hookOwner names. */
function installerHookKeys(): readonly string[] {
  const source = readFileSync(new URL("../../adapters/orca/install-claude-integration.mjs", import.meta.url), "utf8");
  const fileTools = /const FILE_TOOLS_MATCHER = '([^']+)'/.exec(source)?.[1];
  assert.ok(fileTools !== undefined, "FILE_TOOLS_MATCHER is declared in the installer");
  const rows = [...source.matchAll(/\{ event: '(\w+)', matcher: ('[^']+'|FILE_TOOLS_MATCHER), owner: hookOwner\('([^']+)'/g)];
  return rows.map((row) => `${row[1] ?? ""} ${row[2] === "FILE_TOOLS_MATCHER" ? fileTools : (row[2] ?? "").slice(1, -1)} ${row[3] ?? ""}`);
}

test("the registry holds exactly the eight modules, in MODULE_IDS order", () => {
  assert.deepEqual(MODULE_IDS, ["gate", "model-router", "steward", "skill-selection", "board", "verify-done", "ci-watch", "memory"]);
  assert.deepEqual(FEATURE_MODULES.map((module) => module.id), MODULE_IDS);
});

test("the module file lives in the config dir as feature-modules.json", () => {
  assert.equal(FEATURE_MODULES_FILE, "feature-modules.json");
});

test("the registry module is pure: no node: import, so the mod sandbox can load it", () => {
  const source = readFileSync(new URL("./feature_modules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:/);
});

test("defaults: every earlier module is active, so an upgrade with no file keeps 0.6.28 behaviour; verify-done, ci-watch and memory, new, start in shadow", () => {
  assert.deepEqual(DEFAULT_FEATURE_MODULES, { gate: "active", "model-router": "active", steward: "active", "skill-selection": "active", board: "active", "verify-done": "shadow", "ci-watch": "shadow", memory: "shadow" });
  for (const module of FEATURE_MODULES) assert.equal(module.defaultState, module.id === "verify-done" || module.id === "ci-watch" || module.id === "memory" ? "shadow" : "active", module.id);
  assert.deepEqual(parseFeatureModules(""), DEFAULT_FEATURE_MODULES);
});

test("verify-done: off and shadow only, one Jev feature on turn.complete, no settings hook and no worker job", () => {
  const entry = FEATURE_MODULES.find((module) => module.id === "verify-done");
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.states, ["off", "shadow"]);
  assert.equal(entry.defaultState, "shadow");
  assert.deepEqual(entry.modFeatures, [{ id: "verify-done", hooks: ["turn.complete"], jev: true }]);
  assert.deepEqual(entry.hooks, []);
  assert.deepEqual(entry.workerJobs, []);
  assert.deepEqual(entry.modes, []);
  // An upgrade with no module file measures; Off runs nothing of it.
  assert.equal(modFeaturesOn(parseFeatureModules("")).includes("verify-done"), true);
  assert.equal(modFeaturesOn(withStates({ "verify-done": "off" })).includes("verify-done"), false);
  assert.equal(parseFeatureModules(fileWith({ "verify-done": "off" }))["verify-done"], "off");
});

test("ci-watch: off, shadow and active; its own state is the switch, no existing mode; hooks on the mod's events, no Jev, no settings hook, no worker job", () => {
  const entry = FEATURE_MODULES.find((module) => module.id === "ci-watch");
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.states, ["off", "shadow", "active"]);
  assert.equal(entry.defaultState, "shadow");
  assert.equal(entry.ownSwitch, true);
  assert.deepEqual(entry.modFeatures, [{ id: "ci-watch", hooks: ["tool.call", "turn.start", "turn.complete", "ui.render", "session.start"], jev: false }]);
  assert.deepEqual(entry.hooks, []);
  assert.deepEqual(entry.workerJobs, []);
  assert.deepEqual(entry.modes, []);
  // An upgrade with no module file watches in shadow; Off runs nothing of it.
  assert.equal(modFeaturesOn(parseFeatureModules("")).includes("ci-watch"), true);
  assert.equal(modFeaturesOn(withStates({ "ci-watch": "off" })).includes("ci-watch"), false);
  assert.equal(parseFeatureModules(fileWith({ "ci-watch": "active" }))["ci-watch"], "active");
  assert.equal(parseFeatureModules(fileWith({ "ci-watch": "off" }))["ci-watch"], "off");
  assert.equal(parseFeatureModules(fileWith({ "ci-watch": "paused" }))["ci-watch"], "shadow", "a state it does not offer reads as its default");
  // Only ci-watch's and memory's own switches opt out of "shadow caps an existing mode".
  assert.deepEqual(FEATURE_MODULES.filter((module) => module.ownSwitch === true).map((module) => module.id), ["ci-watch", "memory"]);
});

test("memory: off, shadow and active, now that Active writes the files store (odd/tasks/memory-active-files.md A3); three mod features and nothing else", () => {
  const entry = FEATURE_MODULES.find((module) => module.id === "memory");
  assert.ok(entry !== undefined);
  assert.deepEqual(entry.states, ["off", "shadow", "active"]);
  assert.equal(entry.defaultState, "shadow");
  // It uses Haiku, not Jev, so none of its features is a Jev feature.
  assert.deepEqual(entry.modFeatures, [
    { id: "memory-save", hooks: ["turn.complete", "tool.call", "session.start"], jev: false },
    { id: "memory-tidy", hooks: ["turn.complete", "session.compact", "command.run"], jev: false },
    { id: "memory-ui", hooks: ["ui.render"], jev: false },
  ]);
  assert.deepEqual(entry.hooks, []);
  // Its card reads its weekly counts from the shared measurements summary (odd/tasks/memory-shadow.md, M14): no job of its own.
  assert.deepEqual(entry.workerJobs.map((job) => job.id), ["measurements-summary"]);
  assert.equal(workerJobsOn(withStates({ gate: "off", "skill-selection": "off" })).includes("measurements-summary"), true, "memory alone keeps the summary its card reads");
  assert.equal(workerJobsOn(withStates({ gate: "off", "skill-selection": "off", memory: "off" })).includes("measurements-summary"), false);
  assert.deepEqual(entry.modes, []);
  // An upgrade with no module file measures; Off runs none of it.
  const on = modFeaturesOn(parseFeatureModules(""));
  for (const id of ["memory-save", "memory-tidy", "memory-ui"] as const) {
    assert.equal(on.includes(id), true, id);
    assert.equal(modFeaturesOn(withStates({ memory: "off" })).includes(id), false, id);
  }
  // Active has code behind it now: a stored "active" is read as written, and the writer accepts it.
  assert.equal(parseFeatureModules(fileWith({ memory: "active" })).memory, "active");
  assert.equal(validateFeatureModulesInput({ modules: { ...VALID_INPUT.modules, memory: "active" } }).ok, true);
  assert.equal(modFeaturesOn(withStates({ memory: "active" })).includes("memory-save"), true);
  assert.equal(parseFeatureModules(fileWith({ memory: "paused" })).memory, "shadow");
});

test("defaults: each feature's own mode decides, exactly as today", () => {
  const modules = parseFeatureModules("");
  // The router, the steward and the work kind default to measure; the skills mod's two switches to measurement.
  assert.equal(effectiveMode(moduleState(modules, "model-router"), "measure"), "measure");
  assert.equal(effectiveMode(moduleState(modules, "model-router"), "active"), "active");
  assert.equal(effectiveMode(moduleState(modules, "model-router"), "off"), "off");
  assert.equal(effectiveMode(moduleState(modules, "steward"), "measure"), "measure");
  assert.equal(effectiveMode(moduleState(modules, "skill-selection"), switchMode(false)), "measure");
  assert.equal(effectiveMode(moduleState(modules, "skill-selection"), switchMode(true)), "active");
  assert.equal(effectiveMode(moduleState(modules, "gate"), "active"), "active");
});

test("defaults: every installed hook, every mod feature and every worker job stays on", () => {
  const modules = parseFeatureModules("");
  assert.deepEqual(new Set(hooksFor(modules).map(hookKey)), new Set(INSTALLED_HOOKS.map(hookKey)));
  assert.equal(hooksFor(modules).length, INSTALLED_HOOKS.length);
  assert.deepEqual(new Set(modFeaturesOn(modules)), new Set(FEATURE_MODULES.flatMap((module) => module.modFeatures.map((feature) => feature.id))));
  assert.equal(modCopyNeeded(modules), true);
  assert.deepEqual(new Set(workerJobsOn(modules)), new Set(FEATURE_MODULES.flatMap((module) => module.workerJobs.map((job) => job.id))));
});

test("parse: a valid file sets each module's state", () => {
  const modules = parseFeatureModules(fileWith({ gate: "off", "model-router": "shadow", steward: "off", "skill-selection": "shadow", board: "off", "verify-done": "off", "ci-watch": "active", memory: "off" }));
  assert.deepEqual(modules, { gate: "off", "model-router": "shadow", steward: "off", "skill-selection": "shadow", board: "off", "verify-done": "off", "ci-watch": "active", memory: "off" });
});

test("parse: malformed or non-object content falls back to the defaults, never throws", () => {
  for (const content of ["{", "null", "123", '"active"', "[]", "true", JSON.stringify({ modules: null }), JSON.stringify({ modules: [] }), JSON.stringify({ modules: "off" }), JSON.stringify({ gate: "off" })]) {
    assert.deepEqual(parseFeatureModules(content), DEFAULT_FEATURE_MODULES, content);
  }
});

test("parse: a wrong-typed or unknown state falls back for that module alone", () => {
  const modules = parseFeatureModules(fileWith({ gate: false, "model-router": "off", steward: 1, "skill-selection": "measure", board: null }));
  assert.deepEqual(modules, withStates({ "model-router": "off" }));
});

test("parse: unknown module ids are ignored", () => {
  const modules = parseFeatureModules('{"modules":{"steward":"off","jev-belay":"active","__proto__":"off","constructor":"off"}}');
  assert.deepEqual(modules, withStates({ steward: "off" }));
  assert.deepEqual(Object.keys(modules), MODULE_IDS);
});

test("parse: a state the module does not support falls back to its default", () => {
  // The gate and the board have no measure mode, so no shadow (a second shadow switch is never added);
  // verify-done only measures, so no active.
  const modules = parseFeatureModules(fileWith({ gate: "shadow", board: "shadow", steward: "shadow", "verify-done": "active" }));
  assert.deepEqual(modules, withStates({ steward: "shadow" }));
});

test("moduleState reads one module's state", () => {
  const modules = withStates({ steward: "off", "skill-selection": "shadow" });
  assert.equal(moduleState(modules, "steward"), "off");
  assert.equal(moduleState(modules, "skill-selection"), "shadow");
  assert.equal(moduleState(modules, "gate"), "active");
});

test("effectiveMode: off wins over every existing mode (zero Jev calls)", () => {
  for (const own of ["off", "measure", "active"] as const) assert.equal(effectiveMode("off", own), "off", own);
});

test("effectiveMode: shadow caps the existing mode at measure and never turns on an own off", () => {
  const expected: Record<FeatureMode, FeatureMode> = { off: "off", measure: "measure", active: "measure" };
  for (const own of ["off", "measure", "active"] as const) assert.equal(effectiveMode("shadow", own), expected[own], own);
});

test("effectiveMode: active leaves the existing mode to decide", () => {
  for (const own of ["off", "measure", "active"] as const) assert.equal(effectiveMode("active", own), own, own);
});

test("switchMode maps the skills mod's and the legacy model switch's boolean onto measure/active", () => {
  assert.equal(switchMode(false), "measure");
  assert.equal(switchMode(true), "active");
});

test("hooksFor: an off module's entries are left out; shadow keeps them", () => {
  const gateOff = hooksFor(withStates({ gate: "off" }));
  assert.deepEqual(gateOff.map((hook) => hook.script), ["agent-model.ts", "agent-model.ts", "agent-model.ts"]);
  const routerOff = hooksFor(withStates({ "model-router": "off" }));
  assert.deepEqual(new Set(routerOff.map((hook) => hook.script)), new Set(["gate-bash.ts", "gate-outcome.ts", "gate-files.mjs"]));
  assert.equal(routerOff.length, 5);
  assert.deepEqual(hooksFor(withStates({ gate: "off", "model-router": "off" })), []);
  assert.equal(hooksFor(withStates({ "model-router": "shadow" })).length, 8);
});

test("modFeaturesOn and modCopyNeeded: the mod copy stays while any mod module is on", () => {
  const skillsOff = withStates({ "skill-selection": "off" });
  assert.equal(modFeaturesOn(skillsOff).includes("skill-selection"), false);
  assert.equal(modFeaturesOn(skillsOff).includes("tool-selection"), false);
  assert.equal(modFeaturesOn(skillsOff).includes("router-tier"), true);
  assert.equal(modCopyNeeded(skillsOff), true);
  const modModulesOff = withStates({ "model-router": "off", steward: "off", "skill-selection": "off", "verify-done": "off", "ci-watch": "off", memory: "off" });
  assert.deepEqual(modFeaturesOn(modModulesOff), []);
  assert.equal(modCopyNeeded(modModulesOff), false);
  // verify-done, ci-watch or memory in shadow is a mod module on: any one keeps the copy alone.
  assert.equal(modCopyNeeded(withStates({ "model-router": "off", steward: "off", "skill-selection": "off", "ci-watch": "off", memory: "off" })), true);
  assert.equal(modCopyNeeded(withStates({ "model-router": "off", steward: "off", "skill-selection": "off", "verify-done": "off", memory: "off" })), true);
  assert.equal(modCopyNeeded(withStates({ "model-router": "off", steward: "off", "skill-selection": "off", "verify-done": "off", "ci-watch": "off" })), true);
  assert.equal(modCopyNeeded(withStates({ "model-router": "off", steward: "off", "skill-selection": "off" })), true);
  assert.equal(modCopyNeeded(withStates({ "model-router": "off", steward: "off", "skill-selection": "off", "verify-done": "off" })), true);
  assert.equal(modCopyNeeded(withStates({ gate: "off", board: "off" })), true);
  assert.equal(modCopyNeeded(withStates({ "model-router": "off", steward: "off", "skill-selection": "shadow" })), true);
});

test("workerJobsOn: a shared job runs while any owner is on, and is listed once", () => {
  const all = workerJobsOn(DEFAULT_FEATURE_MODULES);
  assert.equal(all.length, new Set(all).size);
  assert.equal(workerJobsOn(withStates({ gate: "off" })).includes("measurements-summary"), true);
  assert.equal(workerJobsOn(withStates({ gate: "off", "skill-selection": "off", memory: "off" })).includes("measurements-summary"), false);
  assert.equal(workerJobsOn(withStates({ "model-router": "off" })).includes("consumption-summary"), true);
  assert.equal(workerJobsOn(withStates({ "model-router": "off", steward: "off" })).includes("consumption-summary"), false);
  assert.equal(workerJobsOn(withStates({ gate: "off" })).includes("gate-authorizations"), false);
  const boardOff = workerJobsOn(withStates({ board: "off" }));
  for (const id of ["board-agent-status", "board-worktree-created", "board-worktree-removed"] as const) assert.equal(boardOff.includes(id), false, id);
  assert.deepEqual(workerJobsOn(withStates({ gate: "off", "model-router": "off", steward: "off", "skill-selection": "off", board: "off", memory: "off" })), [], "verify-done owns no worker job");
});

test("workerJobsFor: the jobs behind each trigger, whichever module owns them (T0's shared timers)", () => {
  assert.deepEqual([...workerJobsFor("interval-15s")].sort(), ["gate-authorizations", "measurements-summary", "model-measurements"]);
  assert.deepEqual([...workerJobsFor("interval-account-quota-10min")].sort(), ["account-quota", "model-docs-check", "router-status"]);
  assert.deepEqual(workerJobsFor("interval-consumption-10min"), ["consumption-summary"]);
  assert.deepEqual(workerJobsFor("interval-activity-10min"), ["activity-summary"]);
  assert.deepEqual([...workerJobsFor("agent.status.changed")], ["board-agent-status"]);
  assert.equal(new Set(workerJobsFor("poll")).size, workerJobsFor("poll").length, "listed once");
  // The router status is also refreshed on a panel request, which spawns a sidecar: it is a poll job.
  assert.equal(workerJobsFor("poll").includes("router-status"), true);
});

test("workerTriggerOn: a timer is wanted until every module using it is off", () => {
  const fifteenSeconds: WorkerTrigger = "interval-15s";
  assert.equal(workerTriggerOn(DEFAULT_FEATURE_MODULES, fifteenSeconds), true);
  // Gate, model-router, skill-selection and memory use it: any one keeps it.
  assert.equal(workerTriggerOn(withStates({ gate: "off", "model-router": "off" }), fifteenSeconds), true);
  assert.equal(workerTriggerOn(withStates({ gate: "off", "model-router": "off", "skill-selection": "off", memory: "off" }), fifteenSeconds), false);
  // The steward's jobs are not on the 15 s timer, so only the shared 10 min ones keep it.
  assert.equal(workerTriggerOn(withStates({ gate: "off", "model-router": "off", "skill-selection": "off", board: "off" }), "interval-consumption-10min"), true);
  assert.equal(workerTriggerOn(withStates({ "model-router": "off", steward: "off" }), "interval-consumption-10min"), false);
  assert.equal(workerTriggerOn(withStates({ "model-router": "off", gate: "off" }), "interval-activity-10min"), false);
  assert.equal(workerTriggerOn(withStates({ board: "off" }), "agent.status.changed"), false);
  assert.equal(workerTriggerOn(withStates({ "model-router": "off", steward: "off" }), "interval-account-quota-10min"), false);
  assert.equal(workerTriggerOn(withStates({ "model-router": "off" }), "interval-account-quota-10min"), true, "the steward still reads the router status");
});

test("workerJobIsPanelOnly: exactly the interval jobs whose output only a panel reads (T4b classification)", () => {
  const panelOnly = FEATURE_MODULES.flatMap((module) => module.workerJobs)
    .filter((job) => workerJobIsPanelOnly(job.id))
    .map((job) => job.id);
  assert.deepEqual([...new Set(panelOnly)].sort(), ["activity-summary", "consumption-summary", "gate-authorizations", "measurements-summary", "router-status"]);
  // Decision inputs keep their cadence: model-measurements re-mirrors the `ready` flag the Agent hook reads, account-quota writes the quota.json the router reads.
  for (const id of ["model-measurements", "account-quota"] as const) assert.equal(workerJobIsPanelOnly(id), false, id);
  // The daily docs check spawns nothing, so gating it saves nothing.
  assert.equal(workerJobIsPanelOnly("model-docs-check"), false);
  // Only interval jobs are gated: a panel-only job is never an event handler.
  for (const job of FEATURE_MODULES.flatMap((module) => module.workerJobs)) {
    if (workerJobIsPanelOnly(job.id)) assert.equal(job.triggers.some((trigger) => trigger.startsWith("interval-")), true, job.id);
  }
});

test("workerTriggerWanted: a timer of panel-only jobs exists only while a panel is open; one with a decision input always does", () => {
  // Every job on these two timers only feeds a panel.
  for (const trigger of ["interval-consumption-10min", "interval-activity-10min"] as const) {
    assert.equal(workerTriggerWanted(DEFAULT_FEATURE_MODULES, trigger, false), false, trigger);
    assert.equal(workerTriggerWanted(DEFAULT_FEATURE_MODULES, trigger, true), true, trigger);
  }
  // model-measurements (15 s) and account-quota (10 min) are decision inputs: their timers stay while model-router is on.
  assert.equal(workerTriggerWanted(DEFAULT_FEATURE_MODULES, "interval-15s", false), true);
  assert.equal(workerTriggerWanted(DEFAULT_FEATURE_MODULES, "interval-account-quota-10min", false), true);
  // With model-router off the 15 s timer holds only panel-only jobs.
  const routerOff = withStates({ "model-router": "off" });
  assert.equal(workerTriggerWanted(routerOff, "interval-15s", false), false);
  assert.equal(workerTriggerWanted(routerOff, "interval-15s", true), true);
  // Off still wins: nothing is wanted when every owner is off, panel open or not.
  const allOff = withStates({ gate: "off", "model-router": "off", steward: "off", "skill-selection": "off", board: "off", memory: "off" });
  assert.equal(workerTriggerWanted(allOff, "interval-15s", true), false);
  // Event handlers do not depend on a panel.
  assert.equal(workerTriggerWanted(DEFAULT_FEATURE_MODULES, "agent.status.changed", false), true);
});

test("every hook the installer installs today is owned by exactly one module", () => {
  for (const hook of INSTALLED_HOOKS) {
    const owners = FEATURE_MODULES.filter((module) => module.hooks.some((owned) => hookKey(owned) === hookKey(hook)));
    assert.equal(owners.length, 1, hookKey(hook));
  }
  const registered = FEATURE_MODULES.flatMap((module) => module.hooks.map(hookKey));
  assert.deepEqual([...registered].sort(), INSTALLED_HOOKS.map(hookKey).sort());
});

test("the fixed hook list mirrors the installer's hookSpecs", () => {
  assert.deepEqual(installerHookKeys(), INSTALLED_HOOKS.map(hookKey));
});

test("every mod feature is owned by exactly one module, and job ids are unique per module", () => {
  const features = FEATURE_MODULES.flatMap((module) => module.modFeatures.map((feature) => feature.id));
  assert.equal(features.length, new Set(features).size);
  for (const module of FEATURE_MODULES) {
    const jobs = module.workerJobs.map((job) => job.id);
    assert.equal(jobs.length, new Set(jobs).size, module.id);
  }
});

test("a module offers shadow exactly when one of its existing modes has a measure value, when it only measures (no active), or when its state is its own switch", () => {
  for (const module of FEATURE_MODULES) {
    const hasMeasure = module.modes.some((mode) => mode.shadowValue !== null);
    const measuresOnly = !module.states.includes("active");
    const ownSwitch = module.ownSwitch === true;
    assert.equal(module.states.includes("shadow"), hasMeasure || measuresOnly || ownSwitch, module.id);
    // A module that only measures, or whose state is its own switch, has no existing mode: its shadow is its own, so there is still one switch.
    if (measuresOnly || ownSwitch) assert.deepEqual(module.modes, [], module.id);
    assert.equal(module.states.includes("off"), true, module.id);
    assert.equal(module.states.includes(module.defaultState), true, module.id);
  }
});

// T5: the writer path (the worker's feature-modules-save sidecar) refuses what
// parseFeatureModules would silently turn into defaults, so a corrupt request
// is reported instead of written.
const VALID_INPUT = { modules: { gate: "off", "model-router": "shadow", steward: "active", "skill-selection": "shadow", board: "off", "verify-done": "shadow", "ci-watch": "active", memory: "shadow" } };

test("validateFeatureModulesInput accepts every module with a state it offers", () => {
  const result = validateFeatureModulesInput(VALID_INPUT);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.modules, VALID_INPUT.modules);
});

test("validateFeatureModulesInput refuses anything that is not the full, valid map", () => {
  const refused: readonly unknown[] = [
    null,
    "off",
    [],
    {},
    { modules: null },
    { modules: [] },
    { modules: { ...VALID_INPUT.modules, gate: "shadow" } },
    { modules: { ...VALID_INPUT.modules, board: "shadow" } },
    { modules: { ...VALID_INPUT.modules, "verify-done": "active" } },
    { modules: { ...VALID_INPUT.modules, "ci-watch": "paused" } },
    { modules: Object.fromEntries(Object.entries(VALID_INPUT.modules).filter(([id]) => id !== "ci-watch")) },
    { modules: { ...VALID_INPUT.modules, steward: "paused" } },
    { modules: { ...VALID_INPUT.modules, steward: true } },
    { modules: { ...VALID_INPUT.modules, unknown: "off" } },
    { modules: { gate: "off" } },
  ];
  for (const input of refused) {
    const result = validateFeatureModulesInput(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) assert.equal(typeof result.detail, "string");
  }
});
