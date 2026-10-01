import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GATE_OWN_CACHE_FILES, GATE_OWN_CONFIG_FILES, commandWritesGateOwnFile, gateOwnFileAt, gateOwnFiles } from "./gate_own_files.ts";

const HOME = "/home/dev";
const CONFIG = "/home/dev/.config/orca-supervisor";
const CACHE = "/home/dev/.cache/orca-supervisor";
const ORCA = "/home/dev/.config/orca";
const PROJECT = "/home/dev/Projects/app";
const OWN = gateOwnFiles({ configDir: CONFIG, cacheDir: CACHE, orcaUserDataDir: ORCA });
const writes = (command: string, cwd: string = PROJECT) => commandWritesGateOwnFile(command, cwd, HOME, OWN);

test("gateOwnFiles: the decision inputs the gate and the router read, and nothing else in those directories", () => {
  for (const name of ["catalog.json", "policies.json", "team-owners.json", "queue-mode.json", "deny-tier-config.json", "models-catalog.json", "explicit-models.json", "quota.json", "mod-skills-config.json", "env"]) {
    assert.ok(GATE_OWN_CONFIG_FILES.includes(name), name);
    assert.equal(gateOwnFileAt(`${CONFIG}/${name}`, OWN), `${CONFIG}/${name}`, name);
  }
  for (const name of ["gate-bash.json", "gate-advice-retry.json", "gate-enablement.json", "agent-model-enablement.json", "human-queue.jsonl"]) {
    assert.ok(GATE_OWN_CACHE_FILES.includes(name), name);
    assert.equal(gateOwnFileAt(`${CACHE}/${name}`, OWN), `${CACHE}/${name}`, name);
  }
  assert.equal(gateOwnFileAt(`${ORCA}/orca-profile-index.json`, OWN), `${ORCA}/orca-profile-index.json`);
  assert.equal(gateOwnFileAt(`${ORCA}/profiles/p1/orca-data.json`, OWN), `${ORCA}/profiles/p1/orca-data.json`);
  assert.equal(gateOwnFileAt(`${CONFIG}/locale`, OWN), null);
  assert.equal(gateOwnFileAt(`${CACHE}/gate-decisions.jsonl`, OWN), null);
  assert.equal(gateOwnFileAt(`${CONFIG}/../orca-supervisor/policies.json`, OWN), `${CONFIG}/policies.json`);
  assert.equal(gateOwnFileAt("/tmp/test-home/.config/orca-supervisor/policies.json", OWN), null);
  assert.equal(gateOwnFileAt(`${PROJECT}/seed/policies.json`, OWN), null);
});

test("commandWritesGateOwnFile: a redirect, tee, sed -i, cp/mv over it, rm, truncate, in every home spelling", () => {
  const file = `${CONFIG}/policies.json`;
  for (const command of [
    "echo '[]' > ~/.config/orca-supervisor/policies.json",
    "echo '[]' >~/.config/orca-supervisor/policies.json",
    'printf x >> "$HOME/.config/orca-supervisor/policies.json"',
    "jq '.[0]' /tmp/p.json | tee ${HOME}/.config/orca-supervisor/policies.json",
    "sed -i '' 's/never/always/' /home/dev/.config/orca-supervisor/policies.json",
    "perl -pi -e 's/a/b/' ~/.config/orca-supervisor/policies.json",
    "cp /tmp/p.json ~/.config/orca-supervisor/policies.json",
    "mv ~/.config/orca-supervisor/policies.json /tmp/p.json",
    "rm -f ~/.config/orca-supervisor/policies.json",
    "truncate -s 0 ~/.config/orca-supervisor/policies.json",
    "dd if=/dev/null of=/home/dev/.config/orca-supervisor/policies.json",
    "cd ~/.config/orca-supervisor && echo '[]' > policies.json",
    "bash -c 'echo [] > ~/.config/orca-supervisor/policies.json'",
    "cat > ~/.config/orca-supervisor/policies.json <<'EOF'\n[]\nEOF",
  ]) {
    assert.equal(writes(command), file, command);
  }
  assert.equal(writes("echo '[]' > policies.json", CONFIG), file);
  assert.equal(writes("cp /tmp/policies.json ~/.config/orca-supervisor/"), file);
  assert.equal(writes("rm -rf ~/.config/orca-supervisor"), CONFIG);
  assert.equal(writes("echo '{}' > ~/.cache/orca-supervisor/gate-bash.json"), `${CACHE}/gate-bash.json`);
  assert.equal(writes("echo x > ~/.config/orca-supervisor/env"), `${CONFIG}/env`);
});

test("commandWritesGateOwnFile: an interpreter that opens one for writing, through the real home", () => {
  const file = `${CONFIG}/deny-tier-config.json`;
  assert.equal(writes("python3 - <<'EOF'\nimport os, json\np = os.path.expanduser('~/.config/orca-supervisor/deny-tier-config.json')\nopen(p, 'w').write('{}')\nEOF"), file);
  assert.equal(writes("node -e \"require('fs').writeFileSync(require('path').join(require('os').homedir(), '.config', 'orca-supervisor', 'deny-tier-config.json'), '{}')\""), file);
  assert.equal(writes("python3 - <<'EOF'\nimport os\nopen(os.path.expanduser('~/.config/orca-supervisor/deny-tier-config.json'), 'w').write('{}')\nEOF"), file);
  assert.equal(writes("python3 -c \"from pathlib import Path; (Path.home() / '.config/orca-supervisor/deny-tier-config.json').write_text('{}')\""), file);
});

test("commandWritesGateOwnFile: reading, other files, mentions and test HOMEs stay allowed", () => {
  for (const command of [
    "cat ~/.config/orca-supervisor/policies.json",
    "jq . ~/.config/orca-supervisor/policies.json > /tmp/policies.json",
    "cp ~/.config/orca-supervisor/policies.json /tmp/backup.json",
    "grep -n never ~/.config/orca-supervisor/policies.json",
    "diff ~/.config/orca-supervisor/policies.json seed/policies.json",
    "echo '[]' > seed/policies.json",
    "echo x > ~/.config/orca-supervisor/locale",
    "rm ~/.cache/orca-supervisor/gate-decisions.jsonl",
    "echo 'never run echo [] > ~/.config/orca-supervisor/policies.json' > notes.md",
    "git commit -m 'refuse rm ~/.config/orca-supervisor/policies.json'",
    "echo '[]' > /tmp/test-home/.config/orca-supervisor/policies.json",
    "HOME=/tmp/test-home bash -c 'echo [] > $HOME/.config/orca-supervisor/policies.json'",
    "python3 - <<'EOF'\nimport json, os\nprint(json.load(open(os.path.expanduser('~/.config/orca-supervisor/policies.json'))))\nEOF",
    "node -e \"const home = process.argv[1]; require('fs').writeFileSync(require('path').join(home, '.config', 'orca-supervisor', 'policies.json'), '[]')\" /tmp/test-home",
    "node --test adapters/orca/install-claude-integration.test.mjs",
    "cat > notes.md <<'EOF'\necho '[]' > ~/.config/orca-supervisor/policies.json\nrm ~/.cache/orca-supervisor/gate-bash.json\nEOF",
  ]) {
    assert.equal(writes(command), null, command);
  }
});

// Shapes of the 0.6.15 false-positive corpus (rewritten without their private
// text): code that reads a protected file and writes another, or edits a
// script whose text names one, is not a write to it.
test("commandWritesGateOwnFile: code that only reads one, or names one in data, is not a write", () => {
  for (const command of [
    "python3 - <<'PY'\nimport json\nfor p in ('package.json','orca-plugin.json'):\n    d=json.load(open(p)); d['version']='0.4.0'\n    open(p,'w').write(json.dumps(d))\nPY\ngh pr create --title x --body \"$(cat <<'EOF'\nThe gate reads ~/.config/orca-supervisor/policies.json, never writes it.\nEOF\n)\"",
    "python3 - <<'EOF'\np='probe.mjs'; s=open(p).read()\ns=s.replace(\"process.env.HOME+'/.cache/orca-supervisor/gate-bash.json'\", \"process.env.CACHE+'/gate-bash.json'\")\nopen(p,'w').write(s)\nEOF",
    "node -e 'const fs=require(\"fs\");const f=process.argv[1];const m=JSON.parse(fs.readFileSync(process.env.HOME+\"/.config/orca-supervisor/policies.json\",\"utf8\"));fs.writeFileSync(f,JSON.stringify(m))' /tmp/storage.json",
  ]) {
    assert.equal(writes(command), null, command);
  }
});

test("commandWritesGateOwnFile: a write through a variable, a chain of them, or a path object", () => {
  assert.equal(writes("python3 - <<'EOF'\nfrom pathlib import Path\nbase = Path.home() / '.config' / 'orca-supervisor'\np = base / 'policies.json'\np.write_text('[]')\nEOF"), `${CONFIG}/policies.json`);
  assert.equal(writes("node - <<'EOF'\nconst os = require('os'), fs = require('fs')\nconst target = `${os.homedir()}/.config/orca-supervisor/team-owners.json`\nfs.writeFileSync(target, '[]')\nEOF"), `${CONFIG}/team-owners.json`);
  assert.equal(writes("python3 -c \"import os; os.remove(os.path.expanduser('~/.cache/orca-supervisor/gate-bash.json'))\""), `${CACHE}/gate-bash.json`);
});

test("commandWritesGateOwnFile: a symlink to one is the file it points at", () => {
  const own = gateOwnFiles({ configDir: CONFIG, cacheDir: CACHE, orcaUserDataDir: ORCA });
  const canonical = (path: string): string => (path === "/tmp/link.json" ? `${CONFIG}/policies.json` : path);
  assert.equal(commandWritesGateOwnFile("echo '[]' > /tmp/link.json", PROJECT, HOME, own, canonical), `${CONFIG}/policies.json`);
  assert.equal(gateOwnFileAt("/tmp/link.json", own, canonical), `${CONFIG}/policies.json`);
});

// 0.6.18 T3 (JEVADV-94): the plugin's Orca storage. The gate never reads it,
// but the panel and the worker rewrite every mirror above from it (and the
// key mirror from its secrets file), so a write there reaches the gate at the
// next refresh. Orca keeps it under `<user data>/plugins-data/<plugin id>/`.
const STORE = `${ORCA}/plugins-data/ab2web.orca-jev-advisor`;

test("gateOwnFiles: the plugin's Orca storage and secrets, and nothing else of Orca's plugin data", () => {
  assert.equal(gateOwnFileAt(`${STORE}/storage.json`, OWN), `${STORE}/storage.json`);
  assert.equal(gateOwnFileAt(`${STORE}/secrets.json.enc`, OWN), `${STORE}/secrets.json.enc`);
  assert.equal(gateOwnFileAt(`${STORE}/storage.json.antes-seed`, OWN), null);
  assert.equal(gateOwnFileAt(`${ORCA}/plugins-data/ab2web.wa-inbox/storage.json`, OWN), null);
  assert.equal(gateOwnFileAt("/tmp/orca-test-profile/plugins-data/ab2web.orca-jev-advisor/storage.json", OWN), null);
});

test("commandWritesGateOwnFile: a write to the plugin's Orca storage, or removing its directory", () => {
  const storage = `${STORE}/storage.json`;
  for (const command of [
    "echo '{}' > ~/.config/orca/plugins-data/ab2web.orca-jev-advisor/storage.json",
    "cp /tmp/s.json $HOME/.config/orca/plugins-data/ab2web.orca-jev-advisor/storage.json",
    "jq '.policies = []' /tmp/s.json | tee ~/.config/orca/plugins-data/ab2web.orca-jev-advisor/storage.json",
    "cd ~/.config/orca/plugins-data/ab2web.orca-jev-advisor && sed -i 's/never/always/' storage.json",
    "python3 - <<'EOF'\nimport os, json\np = os.path.expanduser('~/.config/orca/plugins-data/ab2web.orca-jev-advisor/storage.json')\nopen(p, 'w').write('{}')\nEOF",
  ]) {
    assert.equal(writes(command), storage, command);
  }
  assert.equal(writes("rm -f ~/.config/orca/plugins-data/ab2web.orca-jev-advisor/secrets.json.enc"), `${STORE}/secrets.json.enc`);
  assert.equal(writes("rm -rf ~/.config/orca/plugins-data/ab2web.orca-jev-advisor"), STORE);
  for (const command of [
    "jq .policies ~/.config/orca/plugins-data/ab2web.orca-jev-advisor/storage.json",
    "cp ~/.config/orca/plugins-data/ab2web.orca-jev-advisor/storage.json /tmp/storage-backup.json",
    "echo '{}' > /tmp/orca-test-profile/plugins-data/ab2web.orca-jev-advisor/storage.json",
  ]) {
    assert.equal(writes(command), null, command);
  }
});

test("commandWritesGateOwnFile: the macOS storage path, with its space, quoted or escaped", () => {
  const orca = `${HOME}/Library/Application Support/orca`;
  const own = gateOwnFiles({ configDir: CONFIG, cacheDir: CACHE, orcaUserDataDir: orca });
  const storage = `${orca}/plugins-data/ab2web.orca-jev-advisor/storage.json`;
  assert.equal(commandWritesGateOwnFile('cp /tmp/s.json "$HOME/Library/Application Support/orca/plugins-data/ab2web.orca-jev-advisor/storage.json"', PROJECT, HOME, own), storage);
  assert.equal(commandWritesGateOwnFile("echo '{}' > ~/Library/Application\\ Support/orca/plugins-data/ab2web.orca-jev-advisor/storage.json", PROJECT, HOME, own), storage);
});
