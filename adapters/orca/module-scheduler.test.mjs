// The worker's feature-module scheduler (odd/tasks/feature-modules.md, T4):
// a module that is off runs 0 jobs and spawns 0 sidecars (activation jobs,
// timer ticks, poll requests, event handlers); a timer is cleared only when
// every module using it is off; a state change is picked up with no restart.
// T4b: the jobs whose output only a panel reads (workerJobIsPanelOnly) run
// once at activation and then only while a panel is open; the others keep
// their cadence. Everything here is a fake runner, timer, clock and event
// bus: nothing is spawned and no real time passes.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { DEFAULT_FEATURE_MODULES, FEATURE_MODULES, workerJobIsPanelOnly, workerJobsFor } from '../../src/core/feature_modules.ts'
import { createModuleScheduler, followStatus, modulesFromRead, modulesFromStatus } from './module-scheduler.mjs'

const ALL_OFF = { gate: 'off', 'model-router': 'off', steward: 'off', 'skill-selection': 'off', board: 'off' }

const INTERVAL_TRIGGERS = ['interval-15s', 'interval-account-quota-10min', 'interval-consumption-10min', 'interval-activity-10min']
const EVENT_TRIGGERS = ['agent.status.changed', 'worktree.created', 'worktree.removed']
const PERIODS = { 'interval-15s': 15_000, 'interval-account-quota-10min': 600_000, 'interval-consumption-10min': 600_001, 'interval-activity-10min': 600_002 }

function states (overrides) {
  return { ...DEFAULT_FEATURE_MODULES, ...overrides }
}

/** Every job with an activation or interval trigger has a runner; a runner counts its calls. */
function harness (initial = DEFAULT_FEATURE_MODULES) {
  const calls = []
  const logs = []
  const runners = {}
  const ids = new Set(FEATURE_MODULES.flatMap((module) => module.workerJobs.filter((job) => job.triggers.some((t) => t === 'activation' || t.startsWith('interval-'))).map((job) => job.id)))
  for (const id of ids) runners[id] = async () => { calls.push(id) }
  const eventHandlers = {}
  for (const trigger of EVENT_TRIGGERS) eventHandlers[trigger] = async () => { calls.push(trigger) }

  const clock = { t: 0 }
  const timers = { live: new Map(), cleared: [], next: 1 }
  const timerApi = {
    setInterval: (fn, ms) => {
      const handle = { id: timers.next++, fn, ms, nextAt: clock.t + ms, unref () {} }
      timers.live.set(handle.id, handle)
      return handle
    },
    clearInterval: (handle) => {
      timers.cleared.push(handle.id)
      timers.live.delete(handle.id)
    }
  }
  const subscriptions = { live: new Map(), made: [], next: 1 }
  const subscribe = (name, callback) => {
    const id = subscriptions.next++
    subscriptions.live.set(id, { name, callback })
    subscriptions.made.push(name)
    return () => subscriptions.live.delete(id)
  }
  const scheduler = createModuleScheduler({
    initial,
    runners,
    eventHandlers,
    periods: PERIODS,
    subscribe,
    timers: timerApi,
    now: () => clock.t,
    log: (message) => logs.push(message)
  })
  const liveTimerMs = () => [...timers.live.values()].map((t) => t.ms).sort((a, b) => a - b)
  const tick = async (ms) => {
    for (const handle of [...timers.live.values()]) if (handle.ms === ms) handle.fn()
    await settle()
  }
  /** Moves the fake clock forward, firing every live timer at each of its due instants, in time order. */
  const advance = async (ms) => {
    const target = clock.t + ms
    for (;;) {
      const due = [...timers.live.values()].filter((handle) => handle.nextAt <= target).sort((a, b) => a.nextAt - b.nextAt)[0]
      if (due === undefined) break
      clock.t = due.nextAt
      due.nextAt += due.ms
      due.fn()
      await settle()
    }
    clock.t = target
  }
  const count = (id) => calls.filter((call) => call === id).length
  return { scheduler, calls, logs, timers, subscriptions, liveTimerMs, tick, advance, count, clock }
}

function settle () {
  return new Promise((resolve) => setImmediate(resolve))
}

const everyActivationJob = () => [...new Set(FEATURE_MODULES.flatMap((module) => module.workerJobs.filter((job) => job.triggers.includes('activation')).map((job) => job.id)))]

test('all modules active, no panel open: every activation job runs once; only the 2 timers with a decision input and the 3 event subscriptions exist', async () => {
  const h = harness()
  await h.scheduler.start()
  assert.deepEqual([...h.calls].sort(), everyActivationJob().sort())
  assert.deepEqual(h.liveTimerMs(), [PERIODS['interval-15s'], PERIODS['interval-account-quota-10min']])
  assert.deepEqual([...h.subscriptions.made].sort(), [...EVENT_TRIGGERS].sort())
})

test('every module off: 0 jobs run, 0 timers are set and 0 event handlers are registered', async () => {
  const h = harness(ALL_OFF)
  await h.scheduler.start()
  assert.deepEqual(h.calls, [])
  assert.equal(h.timers.live.size, 0)
  assert.equal(h.subscriptions.made.length, 0)
})

test('an off module runs none of its own jobs; a shared job still runs while another owner is on', async () => {
  const h = harness(states({ gate: 'off' }))
  await h.scheduler.start()
  assert.equal(h.calls.includes('gate-authorizations'), false)
  assert.equal(h.calls.includes('deny-tier-status'), false)
  assert.equal(h.calls.includes('gate-defaults'), false)
  assert.equal(h.calls.includes('measurements-summary'), true, 'skill-selection still uses it')
  assert.equal(h.calls.includes('activity-summary'), true, 'model-router still uses it')
  assert.equal(h.calls.includes('model-measurements'), true)

  const both = harness(states({ gate: 'off', 'skill-selection': 'off' }))
  await both.scheduler.start()
  assert.equal(both.calls.includes('measurements-summary'), false, 'both owners are off')
})

test('a timer tick runs only the jobs that are on', async () => {
  const h = harness(states({ gate: 'off' }))
  await h.scheduler.start()
  await h.scheduler.setPanelOpen(true)
  h.calls.length = 0
  await h.tick(PERIODS['interval-15s'])
  assert.deepEqual([...h.calls].sort(), ['measurements-summary', 'model-measurements'])
})

test('a timer is cleared only when every module using it is off', async () => {
  const h = harness()
  await h.scheduler.start()
  await h.scheduler.setPanelOpen(true)
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), true)

  await h.scheduler.apply(states({ gate: 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), true, 'model-router and skill-selection still use the 15 s timer')

  await h.scheduler.apply(states({ gate: 'off', 'model-router': 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), true, 'skill-selection still uses it')

  await h.scheduler.apply(states({ gate: 'off', 'model-router': 'off', 'skill-selection': 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), false, 'every owner is off: cleared')
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-consumption-10min']), true, 'the steward still reads the consumption summary')
})

test('the shared 10 min timers follow their owners: consumption needs router or steward, activity needs gate or router', async () => {
  const h = harness()
  await h.scheduler.start()
  await h.scheduler.setPanelOpen(true)
  await h.scheduler.apply(states({ 'model-router': 'off', steward: 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-consumption-10min']), false)
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-activity-10min']), true, 'the gate still uses it')
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-account-quota-10min']), false)
  await h.scheduler.apply(states({ 'model-router': 'off', steward: 'off', gate: 'off' }))
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-activity-10min']), false)
})

test('a state change is picked up with no restart: the board handlers come and go', async () => {
  const h = harness(states({ board: 'off' }))
  await h.scheduler.start()
  assert.equal(h.subscriptions.live.size, 0)

  await h.scheduler.apply(states({ board: 'active' }))
  assert.equal(h.subscriptions.live.size, 3)
  const status = [...h.subscriptions.live.values()].find((s) => s.name === 'agent.status.changed')
  status.callback({ any: 'payload' })
  await settle()
  assert.deepEqual(h.calls.filter((c) => c === 'agent.status.changed'), ['agent.status.changed'])

  await h.scheduler.apply(states({ board: 'off' }))
  assert.equal(h.subscriptions.live.size, 0, 'the handlers are unregistered')
})

test('a module turned on runs its activation jobs once; jobs already on are not run again', async () => {
  const h = harness(states({ 'model-router': 'off' }))
  await h.scheduler.start()
  h.calls.length = 0
  await h.scheduler.apply(states({ 'model-router': 'active' }))
  assert.deepEqual([...h.calls].sort(), ['account-quota', 'model-docs-check', 'model-measurements', 'models-catalog'])
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-account-quota-10min']), true)
  h.calls.length = 0
  await h.scheduler.apply(states({ 'model-router': 'shadow' }))
  assert.deepEqual(h.calls, [], 'active to shadow changes no job')
})

test('run: a poll request job is attended only while its module is on', async () => {
  const h = harness(states({ steward: 'off', 'model-router': 'off' }))
  await h.scheduler.start()
  let attended = 0
  assert.equal(await h.scheduler.run('router-config-request', async () => { attended += 1; return 'x' }), undefined)
  assert.equal(attended, 0, 'both owners of the router config request are off')
  await h.scheduler.apply(states({ steward: 'active', 'model-router': 'off' }))
  assert.equal(await h.scheduler.run('router-config-request', async () => { attended += 1; return 'x' }), 'x')
  assert.equal(attended, 1, 'the steward still uses it')
  assert.equal(await h.scheduler.run('trusted-program-request', async () => 'y'), 'y', 'the gate is on')
})

test('a failing job is logged and does not stop the others or the timer', async () => {
  const h = harness()
  const boom = async () => { throw new Error('sidecar exploded') }
  const failing = createModuleScheduler({ initial: DEFAULT_FEATURE_MODULES, runners: { 'measurements-summary': boom, 'model-measurements': async () => { h.calls.push('model-measurements') } }, eventHandlers: {}, periods: PERIODS, subscribe: () => () => {}, timers: { setInterval: (fn, ms) => ({ fn, ms, unref () {} }), clearInterval () {} }, log: (m) => h.logs.push(m) })
  await failing.start()
  assert.deepEqual(h.calls, ['model-measurements'])
  assert.match(h.logs.join('\n'), /measurements-summary.*sidecar exploded/)
})

test('a job that waits for another (the docs check needs the seeded catalog) starts after it', async () => {
  const order = []
  const slow = async () => { order.push('catalog:start'); await settle(); order.push('catalog:end') }
  const docs = async () => { order.push('docs') }
  const scheduler = createModuleScheduler({ initial: DEFAULT_FEATURE_MODULES, runners: { 'models-catalog': slow, 'model-docs-check': docs }, eventHandlers: {}, periods: PERIODS, subscribe: () => () => {}, timers: { setInterval: () => ({ unref () {} }), clearInterval () {} }, log: () => {}, after: { 'model-docs-check': 'models-catalog' } })
  await scheduler.start()
  assert.deepEqual(order, ['catalog:start', 'catalog:end', 'docs'])
})

test('close clears every timer and unregisters every handler, and a later change starts nothing', async () => {
  const h = harness()
  await h.scheduler.start()
  h.scheduler.close()
  assert.equal(h.timers.live.size, 0)
  assert.equal(h.subscriptions.live.size, 0)
  await h.scheduler.apply(states({ board: 'active' }))
  assert.equal(h.timers.live.size, 0)
  assert.equal(h.subscriptions.live.size, 0)
})

const HOUR = 3_600_000
const PANEL_ONLY = ['measurements-summary', 'gate-authorizations', 'router-status', 'consumption-summary', 'activity-summary']

test('T4b classification: the interval jobs a panel reads are marked, the decision inputs are not', () => {
  for (const id of PANEL_ONLY) assert.equal(workerJobIsPanelOnly(id), true, id)
  for (const id of ['model-measurements', 'account-quota', 'model-docs-check']) assert.equal(workerJobIsPanelOnly(id), false, id)
})

test('no panel open: after activation, an hour of simulated time runs no panel-only job and spawns no sidecar for one', async () => {
  const h = harness()
  await h.scheduler.start()
  const afterActivation = h.calls.length
  await h.advance(HOUR)
  for (const id of PANEL_ONLY) assert.equal(h.count(id), 1, `${id} ran at activation and never again`)
  // What is left is the decision inputs, at their own cadence: 240 model-measurements ticks, 6 account-quota and docs-check ticks.
  assert.equal(h.count('model-measurements'), 1 + 240)
  assert.equal(h.count('account-quota'), 1 + 6)
  assert.equal(h.calls.length - afterActivation, 240 + 6 + 6)
})

test('no panel open and no decision input on (model-router off): every timer is gone, an hour passes with zero ticks', async () => {
  const h = harness(states({ 'model-router': 'off' }))
  await h.scheduler.start()
  assert.equal(h.timers.live.size, 0, 'nothing is left to wake the worker for')
  const afterActivation = h.calls.length
  await h.advance(HOUR)
  assert.equal(h.calls.length, afterActivation)
})

test('a panel opens: the stale panel-only jobs refresh at once, then at their own period', async () => {
  const h = harness()
  await h.scheduler.start()
  await h.advance(40_000)
  h.calls.length = 0
  await h.scheduler.setPanelOpen(true)
  assert.deepEqual([...h.calls].sort(), ['gate-authorizations', 'measurements-summary'], 'the 15 s ones were last read 40 s ago; the 10 min ones are still fresh')
  h.calls.length = 0
  await h.advance(45_000)
  assert.equal(h.count('measurements-summary'), 3)
  assert.equal(h.count('gate-authorizations'), 3)
  assert.equal(h.count('model-measurements'), 3)
  assert.equal(h.count('consumption-summary'), 0, 'not due yet')
})

test('a panel opening after a long time refreshes the 10 min jobs too, then keeps their period', async () => {
  const h = harness()
  await h.scheduler.start()
  await h.advance(HOUR)
  h.calls.length = 0
  await h.scheduler.setPanelOpen(true)
  assert.deepEqual([...h.calls].sort(), [...PANEL_ONLY].sort())
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-consumption-10min']), true)
  h.calls.length = 0
  await h.advance(PERIODS['interval-activity-10min'])
  assert.equal(h.count('consumption-summary'), 1)
  assert.equal(h.count('activity-summary'), 1)
  assert.equal(h.count('router-status'), 1)
})

test('a panel that was already open at activation does not repeat the activation read', async () => {
  const h = harness()
  await h.scheduler.setPanelOpen(true)
  await h.scheduler.start()
  assert.equal(h.count('measurements-summary'), 1)
  await h.scheduler.setPanelOpen(true)
  assert.equal(h.count('measurements-summary'), 1, 'a second open signal changes nothing')
})

test('the panel goes away: panel-only ticks stop, the decision inputs keep their cadence, and the timers with nothing left are cleared', async () => {
  const h = harness()
  await h.scheduler.start()
  await h.scheduler.setPanelOpen(true)
  await h.advance(30_000)
  await h.scheduler.setPanelOpen(false)
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-consumption-10min']), false)
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-activity-10min']), false)
  assert.equal(h.liveTimerMs().includes(PERIODS['interval-15s']), true, 'model-measurements still needs it')
  h.calls.length = 0
  await h.advance(HOUR)
  for (const id of PANEL_ONLY) assert.equal(h.count(id), 0, id)
  assert.equal(h.count('model-measurements'), 240)
  assert.equal(h.count('account-quota'), 6)

  const routerOff = harness(states({ 'model-router': 'off' }))
  await routerOff.scheduler.start()
  await routerOff.scheduler.setPanelOpen(true)
  assert.equal(routerOff.timers.live.size > 0, true)
  await routerOff.scheduler.setPanelOpen(false)
  assert.equal(routerOff.timers.live.size, 0, 'only panel-only jobs were left: the worker has nothing to wake for')
})

test('the decision inputs run on the same schedule with or without a panel', async () => {
  const closed = harness()
  await closed.scheduler.start()
  await closed.advance(HOUR)
  const open = harness()
  await open.scheduler.start()
  await open.scheduler.setPanelOpen(true)
  await open.advance(HOUR)
  for (const id of ['model-measurements', 'account-quota', 'model-docs-check']) assert.equal(open.count(id), closed.count(id), id)
})

test('a panel opening never starts a job of a module that is off', async () => {
  const h = harness(states({ gate: 'off', 'model-router': 'off' }))
  await h.scheduler.start()
  await h.scheduler.setPanelOpen(true)
  await h.advance(HOUR)
  assert.equal(h.count('gate-authorizations'), 0)
  assert.equal(h.count('model-measurements'), 0)
  assert.equal(h.count('router-status'), 1 + 6, 'the steward still owns it: activation, then one per 10 min while the panel is open')
  assert.equal(h.count('account-quota'), 0)
})

test('a module switched on while a panel is open gets its timers and its activation jobs; a module turned off loses them', async () => {
  const h = harness(states({ gate: 'off' }))
  await h.scheduler.start()
  await h.scheduler.setPanelOpen(true)
  assert.equal(h.count('gate-authorizations'), 0)
  await h.scheduler.apply(states({ gate: 'active' }))
  assert.equal(h.count('gate-authorizations'), 1, 'activation job of the module just turned on')
  await h.advance(30_000)
  assert.equal(h.count('gate-authorizations'), 3)
  await h.scheduler.apply(states({ gate: 'off' }))
  await h.advance(30_000)
  assert.equal(h.count('gate-authorizations'), 3)
})

test('close ends everything and a late panel signal starts nothing', async () => {
  const h = harness()
  await h.scheduler.start()
  h.scheduler.close()
  h.calls.length = 0
  await h.scheduler.setPanelOpen(true)
  assert.equal(h.timers.live.size, 0)
  assert.deepEqual(h.calls, [])
})

test('every interval trigger of the registry has a period and every event trigger a handler slot', () => {
  for (const trigger of INTERVAL_TRIGGERS) assert.ok(workerJobsFor(trigger).length > 0, trigger)
  for (const trigger of EVENT_TRIGGERS) assert.ok(workerJobsFor(trigger).length > 0, trigger)
})

test('modulesFromStatus: the installer status carries the state it followed; anything else is no news', () => {
  const status = { ok: true, modules: { gate: { state: 'off' }, 'model-router': { state: 'shadow' }, steward: { state: 'active' }, 'skill-selection': { state: 'active' }, board: { state: 'off' }, 'verify-done': { state: 'off' } } }
  assert.deepEqual(modulesFromStatus(status), { gate: 'off', 'model-router': 'shadow', steward: 'active', 'skill-selection': 'active', board: 'off', 'verify-done': 'off' })
  for (const bad of [null, undefined, 'x', { ok: false }, { ok: true }, { ok: true, modules: 3 }]) assert.equal(modulesFromStatus(bad), null, JSON.stringify(bad))
})

test('modulesFromRead: the sidecar answer is re-validated; a failed read is no news', () => {
  assert.deepEqual(modulesFromRead({ ok: true, value: { gate: 'off', 'model-router': 'banana' } }), { ...DEFAULT_FEATURE_MODULES, gate: 'off' })
  for (const bad of [null, { ok: false, reason: 'exception' }, { ok: true }, { ok: true, value: 'x' }]) assert.equal(modulesFromRead(bad), null, JSON.stringify(bad))
})

test('followStatus: the base rescan\'s installer status moves the scheduler, at no extra spawn, and is handed back unchanged', async () => {
  const applied = []
  const scheduler = { apply: async (modules) => { applied.push(modules) } }
  let reads = 0
  const status = { ok: true, targets: [], modules: { gate: { state: 'off' }, 'model-router': { state: 'active' }, steward: { state: 'active' }, 'skill-selection': { state: 'active' }, board: { state: 'active' } } }
  const readStatus = async () => { reads += 1; return status }
  const followed = followStatus(scheduler, readStatus)
  assert.equal(await followed(), status)
  assert.equal(reads, 1, 'one installer run, the same the rescan already made')
  assert.deepEqual(applied, [{ ...DEFAULT_FEATURE_MODULES, gate: 'off' }])

  const failing = followStatus(scheduler, async () => ({ ok: false, reason: 'no-json' }))
  assert.deepEqual(await failing(), { ok: false, reason: 'no-json' })
  assert.equal(applied.length, 1, 'a failed status changes nothing')
})
