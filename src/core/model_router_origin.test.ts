import assert from "node:assert/strict";
import test from "node:test";

import { isPersonPromptOrigin } from "./model_router_origin.ts";

test("composer, bridge, sdk and unclassified are a person's own prompt", () => {
  for (const kind of ["composer", "bridge", "sdk", "unclassified"]) assert.equal(isPersonPromptOrigin(kind), true, kind);
});

test("a task notification, a scheduled trigger, a peer session and a relay are not a person's own prompt", () => {
  for (const kind of [
    "task-notification",
    "scheduled-trigger",
    "peer",
    "peer-send-message",
    "projects-relay",
    "channel",
    "coordinator",
    "observer",
    "observer-activity",
    "auto-continuation",
    "slack-ping",
    "plugin",
  ]) {
    assert.equal(isPersonPromptOrigin(kind), false, kind);
  }
});

test("an unknown kind (a future engine addition) defaults to not-a-person, never a crash", () => {
  assert.equal(isPersonPromptOrigin("something-new"), false);
});
