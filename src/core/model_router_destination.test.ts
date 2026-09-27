import assert from "node:assert/strict";
import test from "node:test";

import { resolveRouterDestination } from "./model_router_destination.ts";

const CATALOG = {
  destinations: [
    { id: "acme-site", label: "Acme site", kind: "client-site", worktreePath: "/work/acme-site", autonomy: {} },
    { id: "tools", label: "Tools", kind: "project", worktreePath: "/work/tools", autonomy: {} },
    { id: "api", label: "API", kind: "service", worktreePath: "/work/api", autonomy: {} },
  ],
};

function policy(id: string, kind: string, destinations?: string[]): Record<string, unknown> {
  return { id, rule: `rule ${id}`, kind, ...(destinations === undefined ? {} : { destinations }) };
}

const GLOBAL_POLICIES = [policy("production", "requires_human"), policy("no_force_push", "prohibits"), policy("read_and_test", "permits")];

test("a client-site cwd (or a folder inside it) resolves to kind client-site", () => {
  const result = resolveRouterDestination({ catalog: CATALOG, policies: GLOBAL_POLICIES, candidates: ["/work/acme-site/src"] });
  assert.equal(result.destinationKind, "client-site");
  assert.equal(result.destinationId, "acme-site");
  assert.equal(result.policyHit, false);
});

test("a requires_human or prohibits policy scoped to the destination is in scope; a permits one is not", () => {
  const scoped = [...GLOBAL_POLICIES, policy("api-freeze", "prohibits", ["api"]), policy("api-review", "permits", ["api"])];
  assert.equal(resolveRouterDestination({ catalog: CATALOG, policies: scoped, candidates: ["/work/api"] }).policyHit, true);
  const onlyPermits = [...GLOBAL_POLICIES, policy("api-review", "permits", ["api"])];
  assert.equal(resolveRouterDestination({ catalog: CATALOG, policies: onlyPermits, candidates: ["/work/api"] }).policyHit, false);
  const human = [policy("api-human", "requires_human", ["api"])];
  assert.equal(resolveRouterDestination({ catalog: CATALOG, policies: human, candidates: ["/work/api"] }).policyHit, true);
});

test("global policies alone never hold the floor: they are command rules the gate already enforces", () => {
  const result = resolveRouterDestination({ catalog: CATALOG, policies: GLOBAL_POLICIES, candidates: ["/work/tools"] });
  assert.equal(result.destinationKind, "project");
  assert.equal(result.policyHit, false);
});

test("a policy scoped to ANOTHER destination is not in scope here", () => {
  const result = resolveRouterDestination({ catalog: CATALOG, policies: [policy("api-freeze", "prohibits", ["api"])], candidates: ["/work/tools"] });
  assert.equal(result.policyHit, false);
});

test("the first candidate that matches wins (cwd, then the linked worktree's main checkout), as the gate does", () => {
  const result = resolveRouterDestination({ catalog: CATALOG, policies: [], candidates: ["/elsewhere/acme-wt", "/work/acme-site"] });
  assert.equal(result.destinationKind, "client-site");
});

test("a missing or malformed catalog is unknown: no kind, no policy hit", () => {
  for (const catalog of [null, { destinations: "nope" }, 42]) {
    const result = resolveRouterDestination({ catalog, policies: [policy("x", "prohibits", ["acme-site"])], candidates: ["/work/acme-site"] });
    assert.deepEqual(result, { destinationKind: null, destinationId: null, policyHit: false, status: "unknown" });
  }
});

test("no matching destination is 'unmatched': no kind, no policy hit", () => {
  const result = resolveRouterDestination({ catalog: CATALOG, policies: [], candidates: ["/somewhere/else"] });
  assert.deepEqual(result, { destinationKind: null, destinationId: null, policyHit: false, status: "unmatched" });
});

test("missing or malformed policies read as none", () => {
  const result = resolveRouterDestination({ catalog: CATALOG, policies: null, candidates: ["/work/api"] });
  assert.equal(result.destinationKind, "service");
  assert.equal(result.policyHit, false);
});
