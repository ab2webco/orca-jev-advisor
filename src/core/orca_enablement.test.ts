import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PLUGIN_ID, activeProfileId, isPluginDisabled, profileDataPath } from "./orca_enablement.ts";

test("the plugin id matches the manifest, so the two can never drift", () => {
  // The gate runs outside Orca and cannot read the manifest at runtime, so the
  // id is a constant. This is what keeps that constant honest.
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../orca-plugin.json", import.meta.url), "utf8"));
  const { publisher, id } = manifest as { publisher: string; id: string };
  assert.equal(PLUGIN_ID, `${publisher}.${id}`);
});

test("reads the plugin out of Orca's own disabled list", () => {
  const data = { settings: { disabledPlugins: ["someone.else", PLUGIN_ID] } };
  assert.equal(isPluginDisabled(data), true);
});

test("an enabled plugin is simply absent from the list", () => {
  assert.equal(isPluginDisabled({ settings: { disabledPlugins: ["someone.else"] } }), false);
  assert.equal(isPluginDisabled({ settings: { disabledPlugins: [] } }), false);
});

test("anything unreadable keeps the gate running rather than silently switching it off", () => {
  // The deliberate direction: a plugin that stops protecting because a file
  // moved is worse than one that keeps asking after being disabled, and the
  // second failure is at least visible to the person it annoys.
  for (const bad of [null, undefined, {}, { settings: null }, { settings: {} }, { settings: { disabledPlugins: "no" } }, { settings: { disabledPlugins: [1, 2] } }, "text", 7]) {
    assert.equal(isPluginDisabled(bad), false);
  }
});

test("finds the profile whose settings are in force", () => {
  assert.equal(activeProfileId({ activeProfileId: "local-default" }), "local-default");
  for (const bad of [null, {}, { activeProfileId: "" }, { activeProfileId: 3 }, "text"]) {
    assert.equal(activeProfileId(bad), null);
  }
});

test("builds the profile data path per platform", () => {
  assert.equal(
    profileDataPath("darwin", "/Users/dev/Library/Application Support/orca", "local-default"),
    "/Users/dev/Library/Application Support/orca/profiles/local-default/orca-data.json",
  );
  assert.equal(
    profileDataPath("win32", "C:\\Users\\dev\\AppData\\Roaming\\orca", "local-default"),
    "C:\\Users\\dev\\AppData\\Roaming\\orca\\profiles\\local-default\\orca-data.json",
  );
});

test("another plugin's id is never mistaken for this one", () => {
  // A prefix match would read `orca-supervisor.orca-jev-advisor` -- a real
  // entry from an earlier install under a different publisher -- as this one.
  const data = { settings: { disabledPlugins: ["orca-supervisor.orca-jev-advisor"] } };
  assert.equal(isPluginDisabled(data), false);
});
