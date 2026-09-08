/**
 * Wire messages for Remote logical streams carried by the gateway's
 * `/m/api/remote.mux` socket.
 *
 * Vendored from `@deepseek-ai/dsh-api-gateway`'s `stream-protocol.ts`
 * (v0.1.2-rc.1, MIT) — the package does not export the message parsers, and
 * the gateway must speak the exact same frames the host's own mux serves the
 * desktop browser. Trimmed to the stream surface: `$events/result` validation
 * stays upstream because that endpoint crosses the HTTP carrier untouched.
 * @module
 */

/** Discriminator for the first item proving the Host event source is ready. */
export const REMOTE_EVENT_STREAM_READY = { type: 'ready' } as const

/** One logical stream request sent from the phone. */
export type RemoteStreamClientMessage =
  | {
    readonly type: 'open'
    readonly streamId: string
    readonly endpoint: string
    readonly payload: unknown
  }
  | { readonly type: 'cancel'; readonly streamId: string }

/** Carrier-safe failure delivered by the Host. */
export interface RemoteStreamFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** One logical stream frame sent from the Host side of the socket. */
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteStreamFailure }
  | { readonly type: 'end'; readonly streamId: string }

/**
 * Parse and validate one phone-to-Host text message.
 * @param text - complete WebSocket text message.
 * @returns the validated logical-stream request.
 */
export function parseRemoteStreamClientMessage(text: string): RemoteStreamClientMessage {
  return parseMessage(text, (value) => {
    if (value.type === 'cancel' && exactKeys(value, ['type', 'streamId']) && validId(value.streamId)) {
      return value as unknown as RemoteStreamClientMessage
    }
    if (value.type === 'open'
      && exactKeys(value, ['type', 'streamId', 'endpoint', 'payload'])
      && validId(value.streamId)
      && typeof value.endpoint === 'string'
      && value.endpoint.length > 0) {
      return value as unknown as RemoteStreamClientMessage
    }
    throw new Error('api gateway: invalid Remote stream client message')
  })
}

/**
 * Parse and validate one Host-to-phone text message.
 * @param text - complete WebSocket text message.
 * @returns the validated logical-stream frame.
 */
export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
  return parseMessage(text, (value) => {
    if (value.type === 'item'
      && (exactKeys(value, ['type', 'streamId']) || exactKeys(value, ['type', 'streamId', 'value']))
      && validId(value.streamId)) {
      return value as unknown as RemoteStreamServerMessage
    }
    if (value.type === 'end' && exactKeys(value, ['type', 'streamId']) && validId(value.streamId)) {
      return value as unknown as RemoteStreamServerMessage
    }
    if (value.type === 'error'
      && exactKeys(value, ['type', 'streamId', 'error'])
      && validId(value.streamId)
      && isRecord(value.error)
      && exactKeys(value.error, ['code', 'message', 'details'])
      && typeof value.error.code === 'string'
      && typeof value.error.message === 'string'
      && isRecord(value.error.details)) {
      return value as unknown as RemoteStreamServerMessage
    }
    throw new Error('api gateway: invalid Remote stream server message')
  })
}

function parseMessage<T>(text: string, validate: (value: Record<string, unknown>) => T): T {
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('api gateway: Remote stream message is not JSON', { cause })
  }
  if (!isRecord(decoded)) throw new Error('api gateway: Remote stream message must be an object')
  return validate(decoded)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
