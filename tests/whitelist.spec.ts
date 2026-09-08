import { describe, expect, it } from 'vitest'
import {
  BASE_METHODS, CREDENTIALS_METHODS, SETTINGS_METHODS, resolveWhitelist,
} from '../src/whitelist.ts'

describe('resolveWhitelist', () => {
  it('always contains the base surface the mobile SDK calls', () => {
    const whitelist = resolveWhitelist({ allowSettings: false, allowCredentials: false, extraMethods: [] })
    for (const method of BASE_METHODS) expect(whitelist.has(method)).toBe(true)
    expect(whitelist.has('session/prompt')).toBe(true)
    expect(whitelist.has('session/page')).toBe(true)
    expect(whitelist.has('session/export')).toBe(true)
    expect(whitelist.has('commands/list')).toBe(true)
    expect(whitelist.has('commands/execute')).toBe(true)
    expect(whitelist.has('llm/discoverModels')).toBe(true)
  })

  it('admits settings and credentials only through their toggles', () => {
    const off = resolveWhitelist({ allowSettings: false, allowCredentials: false, extraMethods: [] })
    expect(off.has('settings/describe')).toBe(false)
    expect(off.has('credentials/set')).toBe(false)

    const on = resolveWhitelist({ allowSettings: true, allowCredentials: true, extraMethods: [] })
    for (const method of SETTINGS_METHODS) expect(on.has(method)).toBe(true)
    for (const method of CREDENTIALS_METHODS) expect(on.has(method)).toBe(true)
  })

  it('never admits loopback-pinned desktop affordances or dead 0.1.1 names', () => {
    const whitelist = resolveWhitelist({ allowSettings: true, allowCredentials: true, extraMethods: [] })
    for (const method of [
      'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument',
      'host.pickDirectory', 'host.openPath',
      // 0.1.1 dotted/renamed names must not linger: the host would 404 them anyway.
      'session.list', 'session.history', 'session.models', 'host.describe',
      'subagent.list', 'goal.create', 'skill.list', 'llm.models',
    ]) {
      expect(whitelist.has(method)).toBe(false)
    }
  })

  it('appends caller-declared extras verbatim', () => {
    const whitelist = resolveWhitelist({ allowSettings: false, allowCredentials: false, extraMethods: ['subagents/history'] })
    expect(whitelist.has('subagents/history')).toBe(true)
  })
})
