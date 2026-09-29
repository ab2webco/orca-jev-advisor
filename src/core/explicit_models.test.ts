import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EXPLICIT_MODELS_CONFIG_KEY, EXPLICIT_MODELS_MIRROR_FILE, parseExplicitModels } from './explicit_models.ts'

test('parseExplicitModels: "keep" is kept, "judge" is judged', () => {
  assert.equal(parseExplicitModels({ mode: 'keep' }), 'keep')
  assert.equal(parseExplicitModels({ mode: 'judge' }), 'judge')
})

test('parseExplicitModels: anything else reads as "judge", the default', () => {
  for (const value of [null, undefined, {}, { mode: 'KEEP' }, { mode: 1 }, 'keep', []]) {
    assert.equal(parseExplicitModels(value), 'judge', JSON.stringify(value))
  }
})

test('one storage key and one mirror file name for the panel, the worker and the hooks', () => {
  assert.equal(EXPLICIT_MODELS_CONFIG_KEY, 'explicitModels')
  assert.equal(EXPLICIT_MODELS_MIRROR_FILE, 'explicit-models.json')
})
