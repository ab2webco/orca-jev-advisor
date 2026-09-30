import assert from "node:assert/strict";
import test from "node:test";

import { agentDefinitionModel, declaredEffort, parseAgentDefinition } from "./agent_definition.ts";

const REVIEWER = "---\nname: reviewer\ndescription: Reviews a diff\nmodel: opus\ntools: Read, Grep\n---\n\nYou review diffs.\n";

test("parseAgentDefinition: reads name and model from the frontmatter", () => {
  assert.deepEqual(parseAgentDefinition(REVIEWER), { name: "reviewer", model: "opus" });
});

test("parseAgentDefinition: quotes and CRLF are tolerated; no frontmatter reads as nothing", () => {
  assert.deepEqual(parseAgentDefinition('---\r\nname: "writer"\r\nmodel: \'claude-sonnet-5\'\r\n---\r\nbody'), { name: "writer", model: "claude-sonnet-5" });
  assert.deepEqual(parseAgentDefinition("# no frontmatter\nmodel: opus\n"), { name: null, model: null });
  assert.deepEqual(parseAgentDefinition("---\nname: open\n"), { name: null, model: null }, "an unclosed frontmatter is not trusted");
});

test("agentDefinitionModel: the model the matching definition fixes, by name or else by file name", () => {
  const files = [
    { file: "writer.md", text: "---\nname: writer\nmodel: sonnet\n---\n" },
    { file: "reviewer.md", text: REVIEWER },
    { file: "helper.md", text: "---\nmodel: haiku\n---\n" },
  ];
  assert.equal(agentDefinitionModel(files, "reviewer"), "opus");
  assert.equal(agentDefinitionModel(files, "helper"), "haiku");
  assert.equal(agentDefinitionModel(files, "general-purpose"), null);
});

test("agentDefinitionModel: inherit, or no model at all, fixes nothing", () => {
  assert.equal(agentDefinitionModel([{ file: "a.md", text: "---\nname: a\nmodel: inherit\n---\n" }], "a"), null);
  assert.equal(agentDefinitionModel([{ file: "b.md", text: "---\nname: b\n---\n" }], "b"), null);
});

test("0.6.16 T3 declaredEffort: a level, a numeric budget, or nothing", () => {
  assert.equal(declaredEffort("high"), "high");
  assert.equal(declaredEffort("max"), "max");
  assert.equal(declaredEffort("12000"), 12000);
  assert.equal(declaredEffort("ultra"), null);
  assert.equal(declaredEffort(null), null);
});
