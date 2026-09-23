// Unit tests for orca_accounts.ts -- pure input to pure output, no
// filesystem, no process.platform read. Run with:
//   node --test src/core/orca_accounts.test.ts
//
// Every test drives a target platform explicitly, exercising win32, darwin
// and linux from this one machine, including a Windows home directory that
// contains a space and both states of XDG_CONFIG_HOME on Linux.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCA_USER_DATA_ENV,
  accountConfigDir,
  accountConfigTarget,
  claudeAccountsDir,
  homeConfigTarget,
  resolveOrcaUserDataDir,
  settingsPathFor,
  skillsDirFor,
} from "./orca_accounts.ts";

test("ORCA_USER_DATA_ENV is the exact variable name Orca sets", () => {
  assert.equal(ORCA_USER_DATA_ENV, "ORCA_USER_DATA_PATH");
});

test("resolveOrcaUserDataDir prefers ORCA_USER_DATA_PATH over any convention, on every platform", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const result = resolveOrcaUserDataDir(platform, {
      home: platform === "win32" ? "C:\\Users\\dev" : "/home/dev",
      orcaUserDataPath: "/opt/custom/orca-userdata",
    });
    assert.equal(result.path, "/opt/custom/orca-userdata");
    assert.equal(result.source, "environment");
  }
});

test("resolveOrcaUserDataDir trims whitespace around the env value", () => {
  const result = resolveOrcaUserDataDir("linux", { home: "/home/dev", orcaUserDataPath: "  /opt/orca  " });
  assert.equal(result.path, "/opt/orca");
});

test("resolveOrcaUserDataDir ignores a blank env value and falls back to convention", () => {
  const result = resolveOrcaUserDataDir("linux", { home: "/home/dev", orcaUserDataPath: "   " });
  assert.equal(result.source, "convention");
});

test("resolveOrcaUserDataDir falls back to %APPDATA%/orca on win32", () => {
  const withAppData = resolveOrcaUserDataDir("win32", { home: "C:\\Users\\dev", appDataDir: "C:\\Users\\dev\\AppData\\Roaming" });
  assert.equal(withAppData.path, "C:\\Users\\dev\\AppData\\Roaming\\orca");
  assert.equal(withAppData.source, "convention");
});

test("resolveOrcaUserDataDir on win32 survives a home directory containing a space, with or without %APPDATA%", () => {
  const withAppData = resolveOrcaUserDataDir("win32", {
    home: "C:\\Users\\Ana Gómez",
    appDataDir: "C:\\Users\\Ana Gómez\\AppData\\Roaming",
  });
  assert.equal(withAppData.path, "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca");

  const withoutAppData = resolveOrcaUserDataDir("win32", { home: "C:\\Users\\Ana Gómez" });
  assert.equal(withoutAppData.path, "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca");
});

test("resolveOrcaUserDataDir on darwin always uses ~/Library/Application Support, XDG or not", () => {
  const result = resolveOrcaUserDataDir("darwin", { home: "/Users/dev", xdgConfigHome: "/Users/dev/.xdgconfig" });
  assert.equal(result.path, "/Users/dev/Library/Application Support/orca");
});

test("resolveOrcaUserDataDir on linux honors XDG_CONFIG_HOME when set", () => {
  const result = resolveOrcaUserDataDir("linux", { home: "/home/dev", xdgConfigHome: "/home/dev/.xdgconfig" });
  assert.equal(result.path, "/home/dev/.xdgconfig/orca");
});

test("resolveOrcaUserDataDir on linux falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
  const result = resolveOrcaUserDataDir("linux", { home: "/home/dev" });
  assert.equal(result.path, "/home/dev/.config/orca");
});

test("resolveOrcaUserDataDir on linux falls back to ~/.config when XDG_CONFIG_HOME is set but empty", () => {
  const result = resolveOrcaUserDataDir("linux", { home: "/home/dev", xdgConfigHome: "" });
  assert.equal(result.path, "/home/dev/.config/orca");
});

test("claudeAccountsDir joins with the right separator per platform", () => {
  assert.equal(claudeAccountsDir("win32", "C:\\Users\\dev\\AppData\\Roaming\\orca"), "C:\\Users\\dev\\AppData\\Roaming\\orca\\claude-accounts");
  assert.equal(claudeAccountsDir("linux", "/home/dev/.config/orca"), "/home/dev/.config/orca/claude-accounts");
});

test("accountConfigDir points at the account's auth subdirectory", () => {
  assert.equal(accountConfigDir("linux", "/home/dev/.config/orca/claude-accounts", "abc123"), "/home/dev/.config/orca/claude-accounts/abc123/auth");
  assert.equal(
    accountConfigDir("win32", "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca\\claude-accounts", "abc123"),
    "C:\\Users\\Ana Gómez\\AppData\\Roaming\\orca\\claude-accounts\\abc123\\auth",
  );
});

test("homeConfigTarget always points at ~/.claude, is not Orca-managed, and stays home-relative on every platform", () => {
  const darwin = homeConfigTarget("darwin", "/Users/dev");
  assert.equal(darwin.id, "home");
  assert.equal(darwin.configDir, "/Users/dev/.claude");
  assert.equal(darwin.orcaManaged, false);

  const win = homeConfigTarget("win32", "C:\\Users\\Ana Gómez");
  assert.equal(win.configDir, "C:\\Users\\Ana Gómez\\.claude");
});

test("accountConfigTarget is Orca-managed and its id embeds the account id", () => {
  const target = accountConfigTarget("linux", "/home/dev/.config/orca/claude-accounts", "abc123def456");
  assert.equal(target.id, "account:abc123def456");
  assert.equal(target.orcaManaged, true);
  assert.equal(target.configDir, "/home/dev/.config/orca/claude-accounts/abc123def456/auth");
});

test("settingsPathFor and skillsDirFor read Claude Code's own config-root convention on every platform", () => {
  const win = homeConfigTarget("win32", "C:\\Users\\Ana Gómez");
  assert.equal(settingsPathFor("win32", win), "C:\\Users\\Ana Gómez\\.claude\\settings.json");
  assert.equal(skillsDirFor("win32", win), "C:\\Users\\Ana Gómez\\.claude\\skills");

  const linux = homeConfigTarget("linux", "/home/dev");
  assert.equal(settingsPathFor("linux", linux), "/home/dev/.claude/settings.json");
  assert.equal(skillsDirFor("linux", linux), "/home/dev/.claude/skills");
});
