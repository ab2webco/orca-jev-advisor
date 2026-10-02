import assert from "node:assert/strict";
import { test } from "node:test";

import { isRegenerablePath } from "./regenerated_files.ts";

test("isRegenerablePath: what the tooling rewrites on its own", () => {
  for (const path of ["apps/web/next-env.d.ts", "next-env.d.ts", "tsconfig.tsbuildinfo", "pkg/tsconfig.build.tsbuildinfo", "apps/web/.next/cache/x", ".next/trace"]) {
    assert.equal(isRegenerablePath(path, "tracked"), true, `tracked ${path}`);
    assert.equal(isRegenerablePath(path, "untracked"), true, `untracked ${path}`);
  }
});

test("isRegenerablePath: a tracked change under a folder called build, out or tmp is source, not output", () => {
  for (const path of ["src/build/config.ts", "tmp/notes.md", "out/report.md", "packages/dist/index.ts", "coverage/summary.md", "lib/.cache/key.ts"]) {
    assert.equal(isRegenerablePath(path, "tracked"), false, `tracked ${path}`);
  }
});

test("isRegenerablePath: untracked output folders are regenerated; untracked source and notes are not", () => {
  for (const path of ["dist/index.js", "build/main.js", "node_modules/x/index.js", "coverage/lcov.info", "apps/web/out/index.html"]) {
    assert.equal(isRegenerablePath(path, "untracked"), true, `untracked ${path}`);
  }
  for (const path of ["src/new.ts", "notes.md", "scripts/run.sh", "docs/plan.md"]) {
    assert.equal(isRegenerablePath(path, "untracked"), false, `untracked ${path}`);
  }
});

test("isRegenerablePath: a secret is never regenerable, whatever folder it sits in", () => {
  for (const path of [".env", ".env.local", "dist/.env", "apps/web/.next/.env.production", "certs/server.pem", "build/id_rsa", "credentials.json"]) {
    assert.equal(isRegenerablePath(path, "tracked"), false, `tracked ${path}`);
    assert.equal(isRegenerablePath(path, "untracked"), false, `untracked ${path}`);
  }
});
