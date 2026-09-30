// 0.6.14 T4 (JEVADV-85): the Models tab names the plugin's own models on a
// catalog that was never seeded, when the worker that plants them has not
// run. A sandboxed panel can read nothing but storage, and storage is exactly
// what is missing then, so the names sit in the panel itself
// (`#models-shipped-labels`). This test holds them to seed/models.json, so a
// release that changes the shipped models cannot leave the panel naming the
// old ones.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the Models tab names exactly the models seed/models.json ships, in its order', async () => {
  const seed = JSON.parse(await readFile(join(ROOT, 'seed/models.json'), 'utf8'))
  const html = await readFile(join(ROOT, 'adapters/orca/panels/config.html'), 'utf8')
  const block = /<script type="application\/json" id="models-shipped-labels">([^<]*)<\/script>/.exec(html)
  assert.ok(block, 'config.html has no #models-shipped-labels block')
  const shipped = [...seed.models].sort((a, b) => a.rank - b.rank).map((row) => row.label)
  assert.deepEqual(JSON.parse(block[1]), shipped)
})
