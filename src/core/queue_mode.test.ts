import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseQueueMode } from './queue_mode.ts'

test('parseQueueMode: enabled true returns true', () => {
  assert.equal(parseQueueMode({ enabled: true }), true)
})

test('parseQueueMode: enabled false returns false', () => {
  assert.equal(parseQueueMode({ enabled: false }), false)
})

test('parseQueueMode: missing enabled returns false', () => {
  assert.equal(parseQueueMode({}), false)
})

test('parseQueueMode: null returns false', () => {
  assert.equal(parseQueueMode(null), false)
})

test('parseQueueMode: undefined returns false', () => {
  assert.equal(parseQueueMode(undefined), false)
})

test('parseQueueMode: non-boolean enabled returns false', () => {
  assert.equal(parseQueueMode({ enabled: 'yes' }), false)
  assert.equal(parseQueueMode({ enabled: 1 }), false)
})
