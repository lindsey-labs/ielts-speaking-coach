import assert from 'node:assert/strict'
import { advanceVoiceEndMonitor } from './voice-end-policy.mjs'

let state = advanceVoiceEndMonitor({}, { active: true, ended: false, composer: false }, { elapsedMs: 2_000 })
assert.equal(state.shouldFinalize, false)
for (let tick = 0; tick < 4; tick += 1) {
  state = advanceVoiceEndMonitor(state, { active: false, ended: false, composer: true }, { elapsedMs: 13_000 + tick * 1_000 })
}
assert.equal(state.shouldFinalize, true)
assert.equal(state.reason, 'voice-surface-closed')

state = advanceVoiceEndMonitor({}, { active: false, ended: true, composer: true }, { elapsedMs: 5_000 })
assert.equal(state.shouldFinalize, true)
assert.equal(state.reason, 'explicit-end-text')

state = advanceVoiceEndMonitor({}, { active: false, ended: true, composer: true }, { elapsedMs: 5_000, busy: true })
assert.equal(state.shouldFinalize, false)
state = advanceVoiceEndMonitor(state, { active: false, ended: true, composer: true }, { elapsedMs: 6_000, busy: false })
assert.equal(state.shouldFinalize, true)

state = {}
for (let tick = 0; tick < 8; tick += 1) {
  state = advanceVoiceEndMonitor(state, { active: false, ended: false, composer: true }, { elapsedMs: 13_000 + tick * 1_000 })
}
assert.equal(state.shouldFinalize, false)

process.stdout.write('Voice end policy tests passed.\n')
