/**
 * Constant-time bearer-token gate for the mobile-gateway routes.
 *
 * The presented `Authorization` header must equal `Bearer <token>` byte for
 * byte; the comparison is timing-safe and a length mismatch is rejected
 * without comparing, so probe timing leaks nothing beyond the token length.
 * @module
 */

import { timingSafeEqual } from 'node:crypto'

/** Headers-shaped view the gate reads (a subset of IncomingHttpHeaders). */
export interface GateHeaders {
  authorization?: unknown
}

/** One configured token's admission check. */
export interface BearerGate {
  /** @param headers - inbound request headers. @returns whether the caller presented the exact token. */
  check(headers: GateHeaders): boolean
}

/**
 * Build the gate for one configured token. An empty/whitespace token is the
 * unpaired state: nothing is valid, so the gate rejects every presentation
 * (pairing happens by rotating a real token in through the settings namespace
 * or the plugin entry config).
 * @param token - the configured secret; empty means unpaired.
 * @returns the admission check for that token.
 */
export function createBearerGate(token: string): BearerGate {
  if (token.trim() === '') {
    return { check: () => false }
  }
  const expected = `Bearer ${token}`
  return {
    check(headers) {
      const presented = headers.authorization
      if (typeof presented !== 'string') return false
      const a = Buffer.from(presented)
      const b = Buffer.from(expected)
      return a.length === b.length && timingSafeEqual(a, b)
    },
  }
}
