import { describe, expect, it } from 'vitest'
import { createBearerGate } from '../src/gate.ts'

function headers(authorization?: string): { authorization?: string } {
  return authorization === undefined ? {} : { authorization }
}

describe('createBearerGate', () => {
  it('admits the exact bearer token', () => {
    expect(createBearerGate('secret').check(headers('Bearer secret'))).toBe(true)
  })

  it('rejects a wrong token, a wrong scheme, and case variations', () => {
    const gate = createBearerGate('secret')
    expect(gate.check(headers('Bearer wrong'))).toBe(false)
    expect(gate.check(headers('bearer secret'))).toBe(false)
    expect(gate.check(headers('Basic secret'))).toBe(false)
    expect(gate.check(headers('secret'))).toBe(false)
  })

  it('rejects a missing header, non-string values, and empty presentations', () => {
    const gate = createBearerGate('secret')
    expect(gate.check(headers(undefined))).toBe(false)
    expect(gate.check({ authorization: ['Bearer secret'] })).toBe(false)
    expect(gate.check(headers(''))).toBe(false)
  })

  it('rejects prefix-extended presentations without comparing', () => {
    const gate = createBearerGate('secret')
    expect(gate.check(headers('Bearer secret-extra'))).toBe(false)
    expect(gate.check(headers('Bearer '))).toBe(false)
  })
})
