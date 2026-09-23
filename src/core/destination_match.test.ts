// Unit tests for matchDestination -- pure input to pure output, no
// filesystem, no network. Run with:
//   node --test src/core/destination_match.test.ts
//
// This covers the cwd -> destination matching direction (the reverse of
// the destination -> live worktree matching in src/projection.ts, which
// this module does not touch). The real motivating bug: a plain equality
// check on worktreePath matches ~1 out of ~62 real sessions for a
// destination like `orca-oss`, because real worktrees are named things
// like `orca-oss-385` or `orca-oss-parked-input` -- siblings that must
// NOT be confused with a nested subdirectory of `orca-oss` itself.

import assert from "node:assert/strict";
import test from "node:test";

import { matchDestination } from "./destination_match.ts";
import type { MatchableDestination } from "./destination_match.ts";

function destination(id: string, worktreePath: string): MatchableDestination {
  return { id, worktreePath };
}

test("matches on exact path equality", () => {
  const oss = destination("orca-oss", "/Users/dev/Projects/orca-oss");
  const result = matchDestination("/Users/dev/Projects/orca-oss", [oss]);
  assert.equal(result, oss);
});

test("matches a nested subdirectory of the destination's worktreePath", () => {
  const oss = destination("orca-oss", "/Users/dev/Projects/orca-oss");
  const result = matchDestination("/Users/dev/Projects/orca-oss/src/core", [oss]);
  assert.equal(result, oss);
});

test("does NOT match a sibling worktree whose name merely starts with the destination's name", () => {
  const oss = destination("orca-oss", "/Users/dev/Projects/orca-oss");
  const result = matchDestination("/Users/dev/Projects/orca-oss-385", [oss]);
  assert.equal(result, null);
});

test("does NOT match the plain destination when the catalog entry is the more specific sibling", () => {
  const ossParked = destination("orca-oss-385", "/Users/dev/Projects/orca-oss-385");
  const result = matchDestination("/Users/dev/Projects/orca-oss", [ossParked]);
  assert.equal(result, null);
});

test("prefers the longest (most specific) matching worktreePath among nested destinations", () => {
  const outer = destination("orca-oss", "/Users/dev/Projects/orca-oss");
  const inner = destination("orca-oss-nested", "/Users/dev/Projects/orca-oss/nested-worktree");
  const result = matchDestination("/Users/dev/Projects/orca-oss/nested-worktree/deep/file", [
    outer,
    inner,
  ]);
  assert.equal(result, inner);
});

test("longest-prefix precedence holds regardless of catalog order", () => {
  const outer = destination("orca-oss", "/Users/dev/Projects/orca-oss");
  const inner = destination("orca-oss-nested", "/Users/dev/Projects/orca-oss/nested-worktree");
  const result = matchDestination("/Users/dev/Projects/orca-oss/nested-worktree", [inner, outer]);
  assert.equal(result, inner);
});

test("normalizes Windows-style backslash separators before matching", () => {
  const oss = destination("orca-oss", "C:\\Users\\x\\Projects\\orca-oss");
  const result = matchDestination("C:\\Users\\x\\Projects\\orca-oss\\sub", [oss]);
  assert.equal(result, oss);
});

test("tolerates a trailing slash on the destination's worktreePath", () => {
  const oss = destination("orca-oss", "/Users/dev/Projects/orca-oss/");
  const result = matchDestination("/Users/dev/Projects/orca-oss/src", [oss]);
  assert.equal(result, oss);
});

test("tolerates a trailing slash on the cwd", () => {
  const oss = destination("orca-oss", "/Users/dev/Projects/orca-oss");
  const result = matchDestination("/Users/dev/Projects/orca-oss/", [oss]);
  assert.equal(result, oss);
});

test("returns null when there are no destinations at all", () => {
  const result = matchDestination("/Users/dev/Projects/orca-oss", []);
  assert.equal(result, null);
});

test("returns null when no destination matches the cwd", () => {
  const oss = destination("orca-oss", "/Users/dev/Projects/orca-oss");
  const result = matchDestination("/Users/dev/Projects/other-project", [oss]);
  assert.equal(result, null);
});
