// Searching this repository's own source must not be refused as if the
// command were the rule it mentions.
//
// Measured live while writing the deny tier: a search for one rule's phrase,
// quoted as an argument, was stopped as "creates, changes or destroys real
// infrastructure". Under `ask` that cost a click. Under `deny` it leaves an
// agent unable to grep the code it is working on -- which is why the mention
// fix and the deny inversion had to ship together.
//
// The phrases are built at run time rather than written literally, so this
// file can be read and edited without the live gate stopping the person
// doing it. That is not cosmetic: the literal version of this test
// interrupted the developer repeatedly.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// fileURLToPath, never `.pathname`: a file URL percent-encodes, so `.pathname`
// hands back "Application%20Support" and the spawn fails with ENOENT at the
// one path that matters -- where Orca actually installs the plugin on macOS.
// This repo's own checkout has no spaces, so CI would never have caught it.
const GATE = fileURLToPath(new URL('./gate-bash.ts', import.meta.url))
const phrase = (...parts) => parts.join(' ')

function decide(command) {
  const home = mkdtempSync(join(tmpdir(), 'jev-mention-'))
  const stdout = execFileSync(
    process.execPath,
    ['--experimental-strip-types', GATE],
    {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: home, tool_use_id: 'probe' }),
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: '',
        XDG_CACHE_HOME: '',
        // src/core/paths.ts's resolveConfigDir/resolveCacheDir refuse to
        // compute a real path at all under node's test runner -- see its
        // module doc. This points them at exactly what they would have
        // computed for `home` on darwin with no XDG override.
        ORCA_SUPERVISOR_CONFIG_DIR: join(home, '.config', 'orca-supervisor'),
        ORCA_SUPERVISOR_CACHE_DIR: join(home, '.cache', 'orca-supervisor'),
      },
      encoding: 'utf8',
    },
  )
  try {
    return JSON.parse(stdout).hookSpecificOutput.permissionDecision
  } catch {
    return 'allow'
  }
}

test('a search that quotes a rule phrase is not refused as that rule', () => {
  for (const quoted of [phrase('terraform', 'apply'), phrase('DROP', 'TABLE'), 'rm -rf /']) {
    assert.notEqual(decide(`grep -rn "${quoted}" src/`), 'deny', quoted)
  }
})

test('actually invoking it is still refused', () => {
  assert.equal(decide(phrase('terraform', 'apply', '-auto-approve')), 'deny')
})
