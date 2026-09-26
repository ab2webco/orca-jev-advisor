// Unit tests for detectDeployPublish -- pure input to pure output.

import assert from "node:assert/strict";
import test from "node:test";

import { detectDeployPublish } from "./deploy_publish.ts";

test("detects a GitHub Actions deployment dispatch -- the real miss (cineco, gh workflow run deploy-azure-dev.yml)", () => {
  const result = detectDeployPublish("gh workflow run deploy-azure-dev.yml --ref release/0.3.1");
  assert.ok(result !== null);
  assert.match(result.description, /deployment workflow on GitHub Actions/);
});

test("detects gh release create", () => {
  assert.ok(detectDeployPublish("gh release create v1.2.0") !== null);
});

test("detects npm/pnpm/yarn publish", () => {
  assert.ok(detectDeployPublish("npm publish --access public") !== null);
  assert.ok(detectDeployPublish("pnpm publish") !== null);
  assert.ok(detectDeployPublish("yarn publish") !== null);
});

test("detects twine upload, cargo publish, gem push, docker push", () => {
  assert.ok(detectDeployPublish("twine upload dist/*") !== null);
  assert.ok(detectDeployPublish("cargo publish") !== null);
  assert.ok(detectDeployPublish("gem push my-gem-1.0.0.gem") !== null);
  assert.ok(detectDeployPublish("docker push registry.example.com/app:latest") !== null);
});

test("detects vercel --prod and vercel deploy, but not a bare preview deploy", () => {
  assert.ok(detectDeployPublish("vercel --prod") !== null);
  assert.ok(detectDeployPublish("vercel deploy") !== null);
  assert.equal(detectDeployPublish("vercel"), null, "a bare preview deploy is not the production floor's concern");
});

test("detects netlify deploy --prod, but not a bare preview deploy", () => {
  assert.ok(detectDeployPublish("netlify deploy --prod") !== null);
  assert.equal(detectDeployPublish("netlify deploy"), null);
});

test("detects fly deploy, eas submit, eas update --branch production", () => {
  assert.ok(detectDeployPublish("fly deploy") !== null);
  assert.ok(detectDeployPublish("eas submit --platform ios") !== null);
  assert.ok(detectDeployPublish("eas update --branch production") !== null);
  assert.equal(detectDeployPublish("eas update --branch preview"), null);
});

test("detects fastlane deliver/pilot/supply, helm install/upgrade, kubectl apply", () => {
  assert.ok(detectDeployPublish("fastlane deliver") !== null);
  assert.ok(detectDeployPublish("fastlane pilot") !== null);
  assert.ok(detectDeployPublish("fastlane supply") !== null);
  assert.ok(detectDeployPublish("helm install my-release ./chart") !== null);
  assert.ok(detectDeployPublish("helm upgrade my-release ./chart") !== null);
  assert.ok(detectDeployPublish("kubectl apply -f manifest.yaml") !== null);
});

test("a mention inside a quoted argument or grep pattern is never detected -- mention-vs-command treatment", () => {
  assert.equal(detectDeployPublish('git commit -m "next: npm publish once tests pass"'), null);
  assert.equal(detectDeployPublish('grep -n "gh workflow run deploy" README.md'), null);
});

test("an ordinary command matches nothing", () => {
  assert.equal(detectDeployPublish("npm test"), null);
  assert.equal(detectDeployPublish("git status"), null);
});
