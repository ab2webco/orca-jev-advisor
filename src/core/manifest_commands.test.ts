import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Orca only routes what the manifest declares. A command registered in
// main.mjs but missing from contributes.commands is not merely inert: Orca
// refuses to deliver *events* to the whole plugin while the mismatch stands
// ("event agent.status.changed dropped: ... registered undeclared command"),
// so the board silently stops following worktrees. That failure surfaces as a
// warning in Orca's log and nowhere else, which is exactly the kind of drift a
// test should catch instead of a person.

const manifest = JSON.parse(
  readFileSync(new URL("../../orca-plugin.json", import.meta.url), "utf8"),
) as { contributes: { commands: Array<{ id: string; title: string }> } };

const mainSource = readFileSync(new URL("../../adapters/orca/main.mjs", import.meta.url), "utf8");

/** Every id main.mjs hands to orca.commands.register, in source order. */
function registeredCommandIds(source: string): string[] {
  return [...source.matchAll(/orca\.commands\.register\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

test("every command main.mjs registers is declared in the manifest", () => {
  const declared = new Set(manifest.contributes.commands.map((c) => c.id));
  const registered = registeredCommandIds(mainSource);

  assert.ok(registered.length > 0, "found no registered commands -- the matcher, not the plugin, is broken");
  for (const id of registered) {
    assert.ok(declared.has(id), `main.mjs registers '${id}' but the manifest does not declare it`);
  }
});

test("every command the manifest declares is actually registered", () => {
  // The other direction matters too: a declared command with nothing behind it
  // shows up in Orca's palette and then does nothing when chosen.
  const registered = new Set(registeredCommandIds(mainSource));
  for (const { id } of manifest.contributes.commands) {
    assert.ok(registered.has(id), `the manifest declares '${id}' but main.mjs never registers it`);
  }
});

test("every declared command carries a non-empty title", () => {
  for (const { id, title } of manifest.contributes.commands) {
    assert.equal(typeof title, "string", `'${id}' has no title`);
    assert.ok(title.trim().length > 0, `'${id}' has a blank title`);
  }
});
