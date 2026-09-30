// 0.6.15 T4c (odd/research/effort-per-task.md §4): measure-only effort
// logging. Where the effort a step is sent with came from, read the way
// Claude Code resolves it, and what switching it cost the prompt cache.
import assert from "node:assert/strict";
import test from "node:test";

import { claudeCodeDefaultEffort, effortSourceOf, settingsEffortFor, uncachedShare } from "./effort_source.ts";

test("claudeCodeDefaultEffort: medium on Opus 5.5 and Sonnet 5.5, high on the rest, none on Haiku", () => {
  assert.equal(claudeCodeDefaultEffort("claude-opus-5-5"), "medium");
  assert.equal(claudeCodeDefaultEffort("claude-opus-5-5[1m]"), "medium");
  assert.equal(claudeCodeDefaultEffort("claude-sonnet-5-5"), "medium");
  assert.equal(claudeCodeDefaultEffort("claude-sonnet-5"), "high");
  assert.equal(claudeCodeDefaultEffort("claude-fable-5-1"), "high");
  assert.equal(claudeCodeDefaultEffort("claude-haiku-4-5-20251001"), null);
});

test("settingsEffortFor: modelSettings for the model; a top-level effortLevel, except on Opus 5.5 where it does not count", () => {
  const settings = { effortLevel: "high", modelSettings: { "claude-sonnet-5-5": { effortLevel: "low" } } };
  assert.equal(settingsEffortFor(settings, "claude-sonnet-5-5"), "low");
  assert.equal(settingsEffortFor(settings, "claude-fable-5-1"), "high");
  assert.equal(settingsEffortFor(settings, "claude-opus-5-5"), null, "a top-level effortLevel is a no-op for Opus 5.5");
  assert.equal(settingsEffortFor({ modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" } } }, "claude-opus-5-5[1m]"), "xhigh");
  assert.equal(settingsEffortFor(null, "claude-opus-5-5"), null);
});

test("effortSourceOf: the plugin, then the environment, the agent's frontmatter, settings, the model default, else the session", () => {
  const base = { carried: "high", sent: "high", env: null, frontmatter: null, settings: null, modelDefault: "medium" } as const;
  assert.equal(effortSourceOf({ ...base, sent: null }), "none");
  assert.equal(effortSourceOf({ ...base, sent: "medium" }), "plugin");
  assert.equal(effortSourceOf({ ...base, env: "high", frontmatter: "high" }), "env");
  assert.equal(effortSourceOf({ ...base, frontmatter: "high", settings: "high" }), "frontmatter");
  assert.equal(effortSourceOf({ ...base, settings: "high" }), "settings");
  assert.equal(effortSourceOf({ ...base, modelDefault: "high" }), "default");
  assert.equal(effortSourceOf(base), "session", "`/effort` or `--effort`, which a hook cannot see");
});

test("uncachedShare: what the step's prompt did not read from cache, over the whole prompt", () => {
  assert.equal(uncachedShare({ input: 100, cacheRead: 9000, cacheWrite: 900 }), 0.1);
  assert.equal(uncachedShare({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(uncachedShare({ input: null, cacheRead: 100, cacheWrite: null }), 0);
});
