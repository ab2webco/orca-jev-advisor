import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isRecord } from "../guards.ts";
import { POLICY_SEED_MARKER_KEY, parseSeedPolicies, parseSeedVersion, shouldSeedPolicies } from "./policy_seed.ts";

const seedFile: unknown = JSON.parse(
  readFileSync(new URL("../../seed/policies.json", import.meta.url), "utf8"),
);

test("the shipped seed is the versioned { version, policies } shape, and every row in it survives validation", () => {
  // The whole defect was a seed nobody read. If a row is ever added that the
  // validator rejects, it would be dropped in silence exactly the way the
  // entire file used to be -- so the count is asserted, not just the parse.
  assert.ok(
    isRecord(seedFile) && Array.isArray(seedFile.policies),
    "seed/policies.json is not the versioned { version, policies } shape",
  );
  const rows = (seedFile as { policies: unknown[] }).policies;
  const parsed = parseSeedPolicies(seedFile);
  assert.equal(parsed.length, rows.length, "some shipped rows are not valid policies");
  assert.ok(parsed.length > 0, "the shipped seed is empty");
});

test("every shipped row carries a kind the gate actually understands", () => {
  const kinds = new Set(parseSeedPolicies(seedFile).map((row) => row.kind));
  for (const kind of kinds) {
    assert.ok(["permits", "requires_human", "prohibits"].includes(kind), `unknown kind: ${kind}`);
  }
});

test("shipped ids are unique, because an id is how a person edits a row later", () => {
  const ids = parseSeedPolicies(seedFile).map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "the shipped seed repeats an id");
});

test("malformed rows cost only themselves", () => {
  const parsed = parseSeedPolicies([
    { id: "good", kind: "permits", rule: "fine" },
    { id: "no-kind", rule: "missing its kind" },
    null,
    "text",
    { id: "bad-kind", kind: "maybe", rule: "unknown kind" },
  ]);
  assert.deepEqual(parsed.map((row) => row.id), ["good"]);
});

test("anything that is neither a bare array nor a { policies } object yields no rows rather than throwing", () => {
  for (const bad of [null, undefined, {}, 7, "text", { rows: [] }]) {
    assert.deepEqual(parseSeedPolicies(bad), []);
  }
});

test("the old bare-array shape this file has always shipped as still parses", () => {
  // The schema change must not strand every seed ever hand-copied out of an
  // older release, or shipped by a fork that has not picked up the version
  // field yet.
  const bareArray = [{ id: "old-shape", kind: "permits", rule: "written before the version wrapper existed" }];
  const parsed = parseSeedPolicies(bareArray);
  assert.deepEqual(parsed.map((row) => row.id), ["old-shape"]);
  assert.equal(parseSeedVersion(bareArray), 0, "a bare array carries no version, and 0 must not be guessed higher");
});

test("the versioned { version, policies } object parses both halves", () => {
  const versioned = {
    version: 3,
    policies: [{ id: "versioned-shape", kind: "prohibits", rule: "written after the version wrapper existed" }],
  };
  assert.deepEqual(parseSeedPolicies(versioned).map((row) => row.id), ["versioned-shape"]);
  assert.equal(parseSeedVersion(versioned), 3);
});

test("parseSeedVersion reports 0 for anything malformed, rather than guessing", () => {
  for (const bad of [
    null,
    undefined,
    [],
    7,
    "text",
    {},
    { version: "1" },
    { version: 1.5 },
    { version: -1 },
    { version: null },
  ]) {
    assert.equal(parseSeedVersion(bad), 0, `expected 0 for ${JSON.stringify(bad)}`);
  }
});

test("a machine that has never been seeded and holds no policies gets the seed", () => {
  assert.equal(shouldSeedPolicies(undefined, undefined), true);
  assert.equal(shouldSeedPolicies(undefined, null), true);
  assert.equal(shouldSeedPolicies(undefined, []), true);
});

test("a row that fails validation is still the person's, and blocks the seed", () => {
  // This is data loss if it regresses. store.ts preserves rows the validator
  // rejects on purpose -- before `kind` existed every row lacked it, and the
  // panel keeps showing them until a human fills it in. Treating that list as
  // empty replaces someone's rules with the shipped ones.
  assert.equal(shouldSeedPolicies(undefined, [{ id: "half" }]), false);
  assert.equal(shouldSeedPolicies(undefined, [{ id: "pre-kind", rule: "written before kind existed" }]), false);
  assert.equal(shouldSeedPolicies(undefined, [{ id: "typo", kind: "prohibit", rule: "kind misspelt by hand" }]), false);
});

test("a marker means never again, which is what keeps a deliberately empty list empty", () => {
  // The reason this is a marker and not an emptiness check: someone who
  // deletes all the shipped rows would otherwise get them back -- ten of them
  // `prohibits` -- on the very next activation.
  assert.equal(shouldSeedPolicies({ at: "2026-09-24T00:00:00.000Z" }, []), false);
  assert.equal(shouldSeedPolicies({ at: "2026-09-24T00:00:00.000Z" }, undefined), false);
});

test("an unrecognised or corrupted marker still counts as seeded", () => {
  // Re-planting is the destructive direction, so anything present wins.
  for (const marker of [true, 0, "", "yes", {}, [], { shape: "from a later version" }]) {
    assert.equal(shouldSeedPolicies(marker, []), false, `marker ${JSON.stringify(marker)} re-seeded`);
  }
});

test("policies already on the machine are never overwritten, marker or not", () => {
  const mine = [{ id: "mine", kind: "prohibits", rule: "my own rule" }];
  assert.equal(shouldSeedPolicies(undefined, mine), false);
  assert.equal(shouldSeedPolicies({ at: "now" }, mine), false);
});

test("the marker key is the literal the worker reads, so a rename cannot go unnoticed", () => {
  assert.equal(POLICY_SEED_MARKER_KEY, "policiesSeeded");
});

test("the seed prohibits discarding uncommitted work, in the same forms the gate denies", () => {
  // An agent's uncommitted work was discarded by `git checkout -- <file>` in a
  // real session. The deny rule is the floor; this row is what Jev's policy
  // coverage sees when that switch is turned down to ask.
  const row = parseSeedPolicies(seedFile).find((policy) => policy.id === "discard_uncommitted_work");
  assert.ok(row, "no discard_uncommitted_work row in the shipped seed");
  assert.equal(row.kind, "prohibits");
  for (const form of ["git checkout --", "git checkout .", "git restore", "git reset --hard", "git clean -f"]) {
    assert.ok(row.rule.includes(form), `the rule does not name ${form}`);
  }
  // Unstaging touches only the index; the row must not make it look forbidden.
  assert.ok(row.rule.includes("--staged"), "the rule does not carve out git restore --staged");
});

test("the shipped seed carries ten prohibits, which is what the marker protects", () => {
  // The comments justifying the marker name this number. A seed that changes
  // shape should force them to be re-read, not quietly outdate them.
  const kinds = parseSeedPolicies(seedFile).reduce<Record<string, number>>((all, row) => {
    all[row.kind] = (all[row.kind] ?? 0) + 1;
    return all;
  }, {});
  assert.equal(kinds.prohibits, 10, "the prohibits count in this module's comments is now wrong");
  assert.equal(kinds.permits, 9);
  assert.equal(kinds.requires_human, 4);
});

/** Sorts every object's keys, recursively, so the digest below depends only
 *  on the shipped rows' actual content -- never on the order the author
 *  happened to type the fields in, or on whitespace JSON.parse already threw
 *  away. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }
  return value;
}

/** The rows' sha256, pinned so an edit that forgets to bump `version` fails
 *  loudly here instead of silently reaching an install that will never know
 *  the baseline changed -- see policy_seed_notice.ts's decidePolicySeedNotice,
 *  which decides `due` from `version` alone and never looks at content. */
const PINNED_DIGEST = "163d37c060a538a502032a99c3359d5b42ca4201200b8420e81234da6bd80e82";

test("editing a shipped policy row without bumping the seed version fails loudly", () => {
  // Pinned together on purpose: a row edit changes the digest, and the
  // failure message below is what tells the author to also bump `version`
  // -- the one thing decidePolicySeedNotice actually compares. Bumping
  // `version` alone (a genuine release) means this test's own pinned
  // version must move too, which is the second assertion.
  const digest = createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(parseSeedPolicies(seedFile))))
    .digest("hex");
  assert.equal(
    digest,
    PINNED_DIGEST,
    `seed/policies.json's rows changed without bumping "version". Bump "version" in ` +
      `seed/policies.json, then replace PINNED_DIGEST in this test with ${JSON.stringify(digest)}.`,
  );
  assert.equal(
    parseSeedVersion(seedFile),
    1,
    'seed/policies.json\'s "version" changed -- update the expected version above (and re-pin ' +
      "PINNED_DIGEST once the rows for that release are final).",
  );
});
