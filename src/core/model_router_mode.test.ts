import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ROUTER_MODE, ROUTER_MODES, ROUTER_SETTINGS_KEY, ROUTER_USER_CONFIG, parseRouterMode, planRouterModeWrite, routerModeFromSettings, withRouterMode } from "./model_router_mode.ts";

test("router mode: off, measure and active; measure is the default", () => {
  assert.deepEqual(ROUTER_MODES, ["off", "measure", "active"]);
  assert.equal(DEFAULT_ROUTER_MODE, "measure");
});

test("parseRouterMode: only the three literal values count; anything else is the default", () => {
  assert.equal(parseRouterMode("active"), "active");
  assert.equal(parseRouterMode("off"), "off");
  assert.equal(parseRouterMode("measure"), "measure");
  assert.equal(parseRouterMode("ACTIVE"), "measure");
  assert.equal(parseRouterMode(true), "measure");
  assert.equal(parseRouterMode(undefined), "measure");
});

test("userConfig: routerMode is a string picker over the three modes, defaulting to measure (§7)", () => {
  const field = ROUTER_USER_CONFIG.routerMode;
  assert.equal(field.type, "string");
  assert.deepEqual(field.options, ["off", "measure", "active"]);
  assert.equal(field.default, "measure");
  assert.equal(typeof field.title, "string");
  assert.equal(typeof field.description, "string");
});

test("routerModeFromSettings: the account settings' pluginConfigs, under the plugin's name or any <name>@<source> key", () => {
  const settings = (key: string, value: unknown): unknown => ({ pluginConfigs: { [key]: { options: { routerMode: value } } } });
  assert.equal(routerModeFromSettings(settings("orca-jev-mod-skills", "active")), "active");
  assert.equal(routerModeFromSettings(settings("orca-jev-mod-skills@inline", "off")), "off");
  assert.equal(routerModeFromSettings(settings("other-plugin", "active")), "measure");
  assert.equal(routerModeFromSettings(settings("orca-jev-mod-skills", "bogus")), "measure");
  assert.equal(routerModeFromSettings(null), "measure");
  assert.equal(routerModeFromSettings({ pluginConfigs: "x" }), "measure");
});

test("withRouterMode: sets the installed plugin's own key (skills-dir), keeping everything else", () => {
  const before = { env: { A: "1" }, hooks: { PreToolUse: [] }, pluginConfigs: { other: { options: { x: 1 } }, [ROUTER_SETTINGS_KEY]: { options: { keep: true } } } };
  const after = withRouterMode(before, "active") as Record<string, unknown>;
  assert.equal(ROUTER_SETTINGS_KEY, "orca-jev-mod-skills@skills-dir");
  assert.deepEqual(after.env, { A: "1" });
  assert.deepEqual(after.hooks, { PreToolUse: [] });
  assert.deepEqual((after.pluginConfigs as Record<string, unknown>).other, { options: { x: 1 } });
  assert.deepEqual((after.pluginConfigs as Record<string, unknown>)[ROUTER_SETTINGS_KEY], { options: { keep: true, routerMode: "active" } });
  assert.equal(routerModeFromSettings(after), "active");
  assert.deepEqual(before.pluginConfigs[ROUTER_SETTINGS_KEY], { options: { keep: true } }, "never mutates its input");
  assert.equal(routerModeFromSettings(withRouterMode(null, "off")), "off");
});

test("finding 10: the installed plugin's own key wins over a leftover @inline key listed first", () => {
  const settings = { pluginConfigs: { "orca-jev-mod-skills@inline": { options: { routerMode: "measure" } }, [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active" } } } };
  assert.equal(routerModeFromSettings(settings), "active");
  const bareFirst = { pluginConfigs: { "orca-jev-mod-skills@inline": { options: { routerMode: "off" } }, "orca-jev-mod-skills": { options: { routerMode: "active" } } } };
  assert.equal(routerModeFromSettings(bareFirst), "active", "then the bare name, then any other source");
});

// ---------------------------------------------------------------------------
// Review round 2, finding 6: planning the settings.json write from its raw text
// ---------------------------------------------------------------------------

test("planRouterModeWrite: a missing file is created with just the router key", () => {
  const plan = planRouterModeWrite(null, "active");
  assert.equal(plan.kind, "write");
  if (plan.kind === "write") assert.equal(routerModeFromSettings(JSON.parse(plan.text)), "active");
});

test("planRouterModeWrite: keeps the person's other keys and their 4-space indent and trailing newline", () => {
  const raw = '{\n    "model": "opus",\n    "permissions": {\n        "allow": ["Bash(ls)"]\n    }\n}\n';
  const plan = planRouterModeWrite(raw, "active");
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.ok(plan.text.startsWith('{\n    "model": "opus",\n    "permissions": {\n        "allow": [\n            "Bash(ls)"\n        ]\n    },'), plan.text);
  assert.ok(plan.text.endsWith("}\n"));
  assert.deepEqual(JSON.parse(plan.text).permissions, { allow: ["Bash(ls)"] });
});

test("planRouterModeWrite: a tab-indented file stays tab-indented; no trailing newline stays so", () => {
  const plan = planRouterModeWrite('{\n\t"model": "opus"\n}', "off");
  assert.equal(plan.kind, "write");
  if (plan.kind === "write") {
    assert.ok(plan.text.includes('\n\t"model": "opus"'));
    assert.equal(plan.text.endsWith("\n"), false);
  }
});

test("planRouterModeWrite: already the requested mode under the installed key is no write at all", () => {
  const raw = JSON.stringify({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active" } } } });
  assert.deepEqual(planRouterModeWrite(raw, "active"), { kind: "unchanged" });
  // The same mode only under a leftover key is NOT what the installed plugin reads: write.
  const leftover = JSON.stringify({ pluginConfigs: { "orca-jev-mod-skills@inline": { options: { routerMode: "active" } } } });
  assert.equal(planRouterModeWrite(leftover, "active").kind, "write");
});

test("planRouterModeWrite: refuses a file that is not a JSON object, never overwriting it", () => {
  assert.deepEqual(planRouterModeWrite("[]", "active"), { kind: "refuse", reason: "not-an-object" });
  assert.deepEqual(planRouterModeWrite("null", "active"), { kind: "refuse", reason: "not-an-object" });
  assert.deepEqual(planRouterModeWrite("{ nope", "active"), { kind: "refuse", reason: "unparseable" });
});

// ---------------------------------------------------------------------------
// 0.6.2 E3: the effort each tier asks for, set per account in the same
// router options the mode lives in.
// ---------------------------------------------------------------------------

import { parseTierEffort, planRouterEffortWrite, routerEffortFromSettings } from "./model_router_mode.ts";

const DEFAULTS = { simple: "medium", standard: "medium", complex: "high", frontier: "xhigh" };

test("parseTierEffort: valid per-tier values override the defaults; anything else is ignored", () => {
  assert.deepEqual(parseTierEffort(undefined), DEFAULTS);
  assert.deepEqual(parseTierEffort({ complex: "xhigh" }), { ...DEFAULTS, complex: "xhigh" });
  assert.deepEqual(parseTierEffort({ frontier: "max", simple: "low" }), { ...DEFAULTS, frontier: "max", simple: "low" });
  assert.deepEqual(parseTierEffort({ complex: "ultra", standard: 3, frontier: null, unknown: "high" }), DEFAULTS);
  assert.deepEqual(parseTierEffort("xhigh"), DEFAULTS);
  assert.deepEqual(parseTierEffort(["high"]), DEFAULTS);
});

test("routerEffortFromSettings: the installed plugin's routerEffort option", () => {
  assert.deepEqual(routerEffortFromSettings(null), DEFAULTS);
  assert.deepEqual(routerEffortFromSettings({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active", routerEffort: { complex: "xhigh" } } } } }), { ...DEFAULTS, complex: "xhigh" });
  assert.deepEqual(routerEffortFromSettings({ pluginConfigs: { "orca-jev-mod-skills@inline": { options: { routerEffort: { simple: "medium" } } }, [ROUTER_SETTINGS_KEY]: { options: { routerEffort: { simple: "high" } } } } }), { ...DEFAULTS, simple: "high" });
});

test("planRouterEffortWrite: stores only what differs from the defaults, next to the mode, keeping everything else", () => {
  const raw = `${JSON.stringify({ model: "opus", pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active" } } } }, null, 4)}\n`;
  const plan = planRouterEffortWrite(raw, { ...DEFAULTS, complex: "xhigh" });
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.ok(plan.text.endsWith("\n"));
  assert.ok(plan.text.includes('    "model"'));
  assert.deepEqual(JSON.parse(plan.text), { model: "opus", pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active", routerEffort: { complex: "xhigh" } } } } });
});

test("planRouterEffortWrite: back to the defaults removes the option; the same value is no write; a broken file is refused", () => {
  const raw = JSON.stringify({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "measure", routerEffort: { complex: "xhigh" } } } } });
  const back = planRouterEffortWrite(raw, DEFAULTS);
  assert.equal(back.kind, "write");
  if (back.kind === "write") assert.deepEqual(JSON.parse(back.text), { pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "measure" } } } });
  assert.equal(planRouterEffortWrite(raw, { ...DEFAULTS, complex: "xhigh" }).kind, "unchanged");
  assert.equal(planRouterEffortWrite(JSON.stringify({}), DEFAULTS).kind, "unchanged");
  assert.deepEqual(planRouterEffortWrite("{ not json", DEFAULTS), { kind: "refuse", reason: "unparseable" });
  assert.deepEqual(planRouterEffortWrite("[]", DEFAULTS), { kind: "refuse", reason: "not-an-object" });
  // 0.6.16 T1: a person's own low on simple work differs from the default, so it is stored and respected.
  const created = planRouterEffortWrite(null, { ...DEFAULTS, simple: "low" });
  assert.equal(created.kind, "write");
  if (created.kind === "write") assert.deepEqual(JSON.parse(created.text), { pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerEffort: { simple: "low" } } } } });
});

test("nit 7: back to the defaults over a stray key writes an explicit empty routerEffort, so the defaults really apply", () => {
  const raw = JSON.stringify({ pluginConfigs: { "orca-jev-mod-skills": { options: { routerEffort: { complex: "low" } } }, [ROUTER_SETTINGS_KEY]: { options: { routerEffort: { complex: "xhigh" } } } } });
  const plan = planRouterEffortWrite(raw, DEFAULTS);
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  const written = JSON.parse(plan.text);
  assert.deepEqual(written.pluginConfigs[ROUTER_SETTINGS_KEY].options.routerEffort, {});
  assert.deepEqual(routerEffortFromSettings(written), DEFAULTS);
  assert.equal(planRouterEffortWrite(plan.text, DEFAULTS).kind, "unchanged");
});

// ---------------------------------------------------------------------------
// Context steward settings: mode and threshold, in the same router options
// ---------------------------------------------------------------------------

import { parseStewardSettingsStrict, planStewardWrite, stewardFromSettings } from "./model_router_mode.ts";

test("stewardFromSettings: measure at 120k by default; the installed plugin's options win", () => {
  // 0.6.15 T4: plus the 400k soft tier's own switch, measure by default.
  assert.deepEqual(stewardFromSettings(null), { mode: "measure", threshold: 120_000, softMode: "measure" });
  assert.deepEqual(stewardFromSettings({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active", stewardMode: "active", stewardThreshold: 30_000 } } } }), { mode: "active", threshold: 30_000, softMode: "measure" });
  assert.deepEqual(stewardFromSettings({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { stewardMode: "loud", stewardThreshold: 5 } } } }), { mode: "measure", threshold: 120_000, softMode: "measure" });
});

test("parseStewardSettingsStrict: both fields valid or null", () => {
  assert.deepEqual(parseStewardSettingsStrict({ mode: "off", threshold: 150_000 }), { mode: "off", threshold: 150_000 });
  assert.equal(parseStewardSettingsStrict({ mode: "loud", threshold: 150_000 }), null);
  assert.equal(parseStewardSettingsStrict({ mode: "active", threshold: 5 }), null);
  assert.equal(parseStewardSettingsStrict({ mode: "active" }), null);
  assert.equal(parseStewardSettingsStrict("active"), null);
});

test("planStewardWrite: next to the router mode, every other key kept; the same value is no write; a broken file is refused", () => {
  const raw = `${JSON.stringify({ theme: "dark", pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active" } } } }, null, 4)}\n`;
  const plan = planStewardWrite(raw, { mode: "active", threshold: 30_000 });
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  const written = JSON.parse(plan.text);
  assert.equal(written.theme, "dark");
  assert.deepEqual(written.pluginConfigs[ROUTER_SETTINGS_KEY].options, { routerMode: "active", stewardMode: "active", stewardThreshold: 30_000 });
  assert.ok(plan.text.startsWith('{\n    "theme"'), "keeps the file's indent");
  assert.equal(planStewardWrite(plan.text, { mode: "active", threshold: 30_000 }).kind, "unchanged");
  assert.deepEqual(planStewardWrite("{ not json", { mode: "off", threshold: 120_000 }), { kind: "refuse", reason: "unparseable" });
  assert.deepEqual(planStewardWrite("[]", { mode: "off", threshold: 120_000 }), { kind: "refuse", reason: "not-an-object" });
  const created = planStewardWrite(null, { mode: "off", threshold: 120_000 });
  assert.equal(created.kind, "write");
  if (created.kind === "write") assert.deepEqual(stewardFromSettings(JSON.parse(created.text)), { mode: "off", threshold: 120_000, softMode: "measure" });
});

// 0.6.15 T4: the 400k soft tier's switch, stored next to the steward's mode.
test("steward soft tier: read from stewardSoftMode, written when given, kept when not; an unknown value is rejected", () => {
  assert.equal(stewardFromSettings({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { stewardSoftMode: "active" } } } }).softMode, "active");
  assert.equal(stewardFromSettings({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { stewardSoftMode: "loud" } } } }).softMode, "measure");
  assert.deepEqual(parseStewardSettingsStrict({ mode: "active", threshold: 150_000, softMode: "active" }), { mode: "active", threshold: 150_000, softMode: "active" });
  assert.equal(parseStewardSettingsStrict({ mode: "active", threshold: 150_000, softMode: "loud" }), null);
  const raw = JSON.stringify({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { stewardMode: "active", stewardThreshold: 120_000, stewardSoftMode: "active" } } } });
  const kept = planStewardWrite(raw, { mode: "active", threshold: 150_000 });
  assert.equal(kept.kind, "write");
  if (kept.kind === "write") assert.equal(stewardFromSettings(JSON.parse(kept.text)).softMode, "active", "a write without softMode keeps the stored one");
  const set = planStewardWrite(raw, { mode: "active", threshold: 120_000, softMode: "measure" });
  assert.equal(set.kind, "write");
  if (set.kind === "write") assert.equal(stewardFromSettings(JSON.parse(set.text)).softMode, "measure");
  assert.equal(planStewardWrite(raw, { mode: "active", threshold: 120_000, softMode: "active" }).kind, "unchanged");
});

// ---------------------------------------------------------------------------
// 0.6.16 T2: the work-kind switch (`workKindMode`), and which tiers' effort
// the person set themselves.
// ---------------------------------------------------------------------------

import { planWorkKindWrite, routerEffortPersonTiers, workKindModeFromSettings } from "./model_router_mode.ts";

test("0.6.16 T2 workKindModeFromSettings: measure by default; the installed plugin's option wins", () => {
  assert.equal(workKindModeFromSettings(null), "measure");
  assert.equal(workKindModeFromSettings({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { workKindMode: "active" } } } }), "active");
  assert.equal(workKindModeFromSettings({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { workKindMode: "loud" } } } }), "measure");
});

test("0.6.16 T2 planWorkKindWrite: next to the router mode, every other key kept; the same value is no write; a broken file is refused", () => {
  const raw = `${JSON.stringify({ model: "opus", pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active" } } } }, null, 4)}\n`;
  const plan = planWorkKindWrite(raw, "active");
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.ok(plan.text.endsWith("\n"));
  assert.ok(plan.text.includes('    "model"'));
  assert.deepEqual(JSON.parse(plan.text), { model: "opus", pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerMode: "active", workKindMode: "active" } } } });
  assert.equal(planWorkKindWrite(plan.text, "active").kind, "unchanged");
  assert.deepEqual(planWorkKindWrite("{ not json", "off"), { kind: "refuse", reason: "unparseable" });
  assert.deepEqual(planWorkKindWrite("[]", "off"), { kind: "refuse", reason: "not-an-object" });
  const created = planWorkKindWrite(null, "off");
  assert.equal(created.kind, "write");
  if (created.kind === "write") assert.deepEqual(JSON.parse(created.text), { pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { workKindMode: "off" } } } });
});

test("0.6.16 T1/T2 routerEffortPersonTiers: the tiers whose effort the person stored", () => {
  assert.deepEqual([...routerEffortPersonTiers(null)], []);
  assert.deepEqual([...routerEffortPersonTiers({ pluginConfigs: { [ROUTER_SETTINGS_KEY]: { options: { routerEffort: { simple: "high", complex: "ultra" } } } } })], ["simple"]);
});
