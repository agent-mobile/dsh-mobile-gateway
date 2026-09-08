/**
 * Loopback guard for the management surface. The pairing page and its admin
 * endpoints render the token and rotate it, so they admit requests whose Host
 * names the local loopback authority only — the same pin the official /api
 * applies to privileged methods. Local reimplementation of the SDK's
 * loopback-hostname helper (the SDK stopped exporting it), reading the Host
 * header the same way.
 * @module
 */

/** Headers-shaped view carrying the Host. */
export interface HostHeaders {
  host?: unknown
  [key: string]: unknown
}

/**
 * Whether one hostname string names the loopback authority: `localhost`,
 * IPv6 loopback, or any IPv4 address in 127/8.
 * @param hostname - normalized URL hostname.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4 === null) return false
  if (v4[1] !== '127') return false
  return v4.slice(2).every(part => Number(part) <= 255)
}

/**
 * Whether one request's Host header names this machine's loopback authority.
 * @param headers - inbound request headers.
 */
export function isLoopbackRequest(headers: HostHeaders): boolean {
  const host = headers.host
  if (typeof host !== 'string') return false
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}
