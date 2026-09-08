/**
 * The gateway's `/m/api/remote.mux` WebSocket carrier: the phone's single
 * logical-stream socket in the 0.1.2 wire protocol. Upgrades admitted by the
 * bearer gate are handed to the vendored {@link RemoteStreamMuxServer}, whose
 * open callback is the host `typertGateway` service's public `wireStream` —
 * so `$events` generations, waterfall deliveries, and `session/follow`
 * transcript streams are owned by the same host-side registries that serve
 * the desktop browser and answer `$events/result` HTTP calls. The gateway
 * adds no stream semantics of its own.
 * @module
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { RemoteStreamMuxServer } from './remote-stream/server.ts'
import type { RemoteStreamFailureMapper, RemoteStreamOpener } from './remote-stream/server.ts'

/**
 * Matches the host gateway's default WebSocket Ping interval; the constant
 * itself is not exported from @deepseek-ai/dsh-api-gateway.
 */
const REMOTE_MUX_HEARTBEAT_MS = 2000

/** The slice of the host typertGateway service the gateway's mux needs. */
export interface GatewayWireStreamSource {
  /** Stream opener and failure mapper shared with the host's own mux. */
  wireStream?: {
    open?: RemoteStreamOpener
    failure?: RemoteStreamFailureMapper
  }
}

/**
 * Extract the host `typertGateway` service's wire stream from a context.
 * The read goes through `ctx.get` because the context proxy itself throws on
 * unprovided service property reads, and the gateway must not depend on the
 * host's Context type augmentation.
 * @param source - the host context (anything exposing cordis's `get`).
 * @returns the opener/failure pair.
 */
export function resolveWireStream(source: unknown): {
  open: RemoteStreamOpener
  failure: RemoteStreamFailureMapper
} {
  let service: unknown = source
  if (typeof (source as { get?: unknown })?.get === 'function') {
    const ctx = source as { get(name: string, strict?: boolean): unknown }
    try {
      service = ctx.get('typertGateway', true)
    } catch {
      // The providing fiber exists but is not active yet (boot order) — the
      // lazy resolution below retries once the composition has settled.
      service = undefined
    }
  }
  const wireStream = (service as GatewayWireStreamSource | undefined)?.wireStream
  if (typeof wireStream?.open !== 'function' || typeof wireStream.failure !== 'function') {
    throw new Error(
      'mobile-gateway: the host context lacks the typertGateway service\'s wireStream '
      + 'required to serve /m/api/remote.mux; the web profile composition is missing '
      + 'the api-gateway plugin or the installed dsh version is incompatible '
      + '(supported: @deepseek-ai/dsh >= 0.1.2-rc.1)',
    )
  }
  return { open: wireStream.open, failure: wireStream.failure }
}

/** The gateway's mux: one vendored server over the host wire stream. */
export class GatewayRemoteMux {
  private readonly server: RemoteStreamMuxServer

  /**
   * @param resolveWire - resolves the host wire stream. Called once lazily and
   * cached, so a plugin that boots before the api-gateway still composes; a
   * stream opening before the service exists throws the descriptive
   * {@link resolveWireStream} error at the earliest resolvable point.
   */
  constructor(resolveWire: () => { open: RemoteStreamOpener, failure: RemoteStreamFailureMapper }) {
    let wireStream: { open: RemoteStreamOpener, failure: RemoteStreamFailureMapper } | undefined
    const wire = (): { open: RemoteStreamOpener, failure: RemoteStreamFailureMapper } =>
      wireStream ??= resolveWire()
    this.server = new RemoteStreamMuxServer(
      (endpoint, payload, signal) => wire().open(endpoint, payload, signal),
      error => wire().failure(error),
      REMOTE_MUX_HEARTBEAT_MS,
    )
  }

  /**
   * Serve one admitted upgrade.
   * @param req - admitted HTTP upgrade request.
   * @param socket - raw socket transferred by the webserver.
   * @param head - bytes already read after the upgrade headers.
   */
  handle(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head)
  }

  /** Terminate owned sockets and await every iterator drain. */
  async close(): Promise<void> {
    await this.server.close()
  }
}

/**
 * Refuse an upgrade before protocol negotiation (token check failed).
 * @param socket - raw HTTP socket that remains owned by the caller.
 */
export function rejectUnauthorizedUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}
