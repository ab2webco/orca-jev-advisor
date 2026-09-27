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
