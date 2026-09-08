/**
 * Connected-device tracking for the gateway surface. Every admitted /m/api
 * request and WebSocket upgrade reports itself here; the loopback management
 * page renders the snapshot, and blocked devices are refused at the route
 * before dispatch. Blocking is in-memory only (a restart clears it) — the
 * durable kill is token rotation.
 * @module
 */

/** Headers-shaped view the tracker reads (subset of IncomingHttpHeaders). */
export interface TrackerHeaders {
  'x-dsh-device'?: unknown
  'x-dsh-device-name'?: unknown
  'user-agent'?: unknown
  [key: string]: unknown
}

/** One tracked device as rendered by the management page. */
export interface DeviceSnapshot {
  /** Stable identity: the app-reported device id, else the client IP. */
  id: string
  /** Friendly name: app-reported name, else a UA/IP-derived label. */
  name: string
  firstSeen: number
  lastSeen: number
  /** Admitted requests since first seen (HTTP + upgrades). */
  requests: number
  /** Live WebSocket downlinks held right now. */
  liveStreams: number
  /** Whether the device looks active (live stream or seen < 30s ago). */
  online: boolean
  /** Whether the device is refused at the route (until restart). */
  blocked: boolean
}

interface DeviceRecord {
  id: string
  name: string
  firstSeen: number
  lastSeen: number
  requests: number
  liveStreams: number
  blocked: boolean
}

/** How long an inactive, unblocked device survives pruning. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000
/** A device counts as online with a live stream or activity this recent. */
const ONLINE_WITHIN_MS = 30_000
/** Upper bound on tracked devices; oldest inactive entries drop first. */
const MAX_TRACKED = 200

/**
 * Strip the IPv6-mapped prefix from a remote address so one client has one id.
 * @param address - `req.socket.remoteAddress`, which may be undefined.
 * @returns the normalized IP literal, or `unknown` when unavailable.
 */
function normalizeIp(address: string | undefined): string {
  if (address === undefined) return 'unknown'
  return address.replace(/^::ffff:/, '')
}

function stringHeader(headers: TrackerHeaders, key: string): string | undefined {
  const value = headers[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, 80)
}

/**
 * Extract a device identity from request facts.
 * @param headers - inbound request headers.
 * @param remoteAddress - the raw socket remote address.
 * @returns the identity the request is accounted to.
 */
export function extractIdentity(headers: TrackerHeaders, remoteAddress: string | undefined): { id: string, name: string } {
  const reported = stringHeader(headers, 'x-dsh-device')
  const id = reported !== undefined ? `dev:${reported}` : `ip:${normalizeIp(remoteAddress)}`
  const name = stringHeader(headers, 'x-dsh-device-name')
    ?? stringHeader(headers, 'user-agent')?.slice(0, 48)
    ?? normalizeIp(remoteAddress)
  return { id, name }
}

/**
 * The connection ledger behind the management page's device list.
 */
export class DeviceTracker {
  private readonly devices = new Map<string, DeviceRecord>()

  /** @param identity - who the request belongs to; bumps its activity. */
  record(identity: { id: string, name: string }): void {
    const now = Date.now()
    const record = this.devices.get(identity.id)
    if (record === undefined) {
      this.devices.set(identity.id, {
        id: identity.id, name: identity.name, firstSeen: now, lastSeen: now, requests: 1, liveStreams: 0, blocked: false,
      })
      this.prune(now)
      return
    }
    record.lastSeen = now
    record.requests += 1
    record.name = identity.name
  }

  /** Adjust one device's live-stream count (upgrade +1 / close −1). */
  streamDelta(identity: { id: string, name: string }, delta: number): void {
    this.record(identity)
    const record = this.devices.get(identity.id)
    if (record === undefined) return
    record.liveStreams = Math.max(0, record.liveStreams + delta)
  }

  /** @param id - device id. @returns whether the device is refused at the route. */
  isBlocked(id: string): boolean {
    return this.devices.get(id)?.blocked === true
  }

  /**
   * Block or unblock one device. Blocking takes effect on the device's next
   * request; in-flight requests complete.
   * @param id - device id. @param blocked - the new state.
   */
  setBlocked(id: string, blocked: boolean): void {
    const record = this.devices.get(id)
    if (record !== undefined) record.blocked = blocked
  }

  /** Copy of the current ledger, most recently active first. */
  snapshot(): DeviceSnapshot[] {
    const now = Date.now()
    this.prune(now)
    return [...this.devices.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map(record => ({
        id: record.id,
        name: record.name,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        requests: record.requests,
        liveStreams: record.liveStreams,
        online: record.liveStreams > 0 || now - record.lastSeen < ONLINE_WITHIN_MS,
        blocked: record.blocked,
      }))
  }

  /** Drop long-idle unblocked entries and cap the ledger size. */
  private prune(now: number): void {
    for (const [id, record] of this.devices) {
      if (!record.blocked && record.liveStreams === 0 && now - record.lastSeen > PRUNE_AFTER_MS) {
        this.devices.delete(id)
      }
    }
    while (this.devices.size > MAX_TRACKED) {
      let oldest: { id: string, lastSeen: number } | undefined
      for (const [id, record] of this.devices) {
        if (record.blocked || record.liveStreams > 0) continue
        if (oldest === undefined || record.lastSeen < oldest.lastSeen) oldest = { id, lastSeen: record.lastSeen }
      }
      if (oldest === undefined) break
      this.devices.delete(oldest.id)
    }
  }
}
