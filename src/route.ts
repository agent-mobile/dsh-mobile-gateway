/**
 * The /m/api HTTP route: bearer gate → method whitelist → `/m` → `/api` path
 * rewrite → the host's shared /api fetch carrier (Typert remote interceptor
 * over the `toFetchHandler` fallback), with the response piped back under
 * backpressure (SSE bodies stream chunk by chunk).
 *
 * `$events/result` (the answerable-frame reply channel for the 0.1.2 single
 * `remote.mux` stream) passes through the same pipe; the WebSocket itself is
 * owned by `remote-mux.ts` instead, so no GET event paths exist here.
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BearerGate } from './gate.ts'
import type { CatalogEnricher } from './catalog.ts'
import type { DeviceTracker } from './devices.ts'
import { extractIdentity } from './devices.ts'
import { RESPOND_ENDPOINT } from './whitelist.ts'

/** The host's shared /api fetch-shaped carrier (the route only feeds it `Request`s). */
export interface FetchCarrier {
  fetch(request: Request): Promise<Response>
}

/** The one method whose response the gateway may rewrite before replying. */
const ENRICHED_METHOD = 'session/modelCatalog'

/**
 * Live gateway state read per request, so settings-driven token rotation and
 * whitelist toggles apply without re-registering routes.
 */
export interface GatewayState {
  /** The admission gate for the current token. */
  gate(): BearerGate
  /** The admission set for the current toggles. */
  whitelist(): ReadonlySet<string>
  /** The current per-request body cap. */
  maxRequestBodyBytes(): number
  /**
   * The catalog capability enricher, or null while the llm runtime has not
   * resolved (the enrichment then stays off and responses pass through).
   */
  enrichModelCatalog(): CatalogEnricher | null
}

/** Constructor inputs for the route handler. */
export interface RouteOptions {
  state: GatewayState
  tracker: DeviceTracker
  carrier: FetchCarrier
}

/** The mounted prefix this handler answers (and strips before forwarding). */
const PREFIX = '/m/api'

/**
 * Build the /m/api route handler.
 *
 * HTTP status semantics mirror the official /api carrier: 401 failed token,
 * 403 refused method, 413 oversized body, and 200 for every business result
 * (business errors travel inside the JSON envelope).
 *
 * @param options - gate, whitelist, carrier, and the request-body cap.
 * @returns the handler for `webServer.register`.
 */
export function createRouteHandler(options: RouteOptions) {
  const { state, tracker, carrier } = options
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const identity = extractIdentity(req.headers, req.socket?.remoteAddress)
    if (!state.gate().check(req.headers)) {
      res.writeHead(401).end('unauthorized')
      return
    }
    if (tracker.isBlocked(identity.id)) {
      res.writeHead(403).end('device blocked')
      return
    }
    tracker.record(identity)
    /* node:http always sets url on server requests; the fallback keeps the
    handler total for hand-built test requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const segment = url.pathname.slice(PREFIX.length).replace(/^\//, '')
    if (segment === '') {
      res.writeHead(404).end('not found')
      return
    }
    const whitelist = state.whitelist()
    const admitted = segment === RESPOND_ENDPOINT || whitelist.has(segment)
    if (!admitted) {
      res.writeHead(403).end(`forbidden method: ${segment}`)
      return
    }

    // Abort the internal dispatch when the client goes away mid-request. The
    // close hook must hang off the response, not the request: since Node 16,
    // the request's 'close' fires as soon as its body is consumed.
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })

    // Buffer the request body with a cap (same policy as the official /api
    // bridge: the cap is also the per-request resident bound).
    let body: Buffer | undefined
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const maxRequestBodyBytes = state.maxRequestBodyBytes()
      const declared = req.headers['content-length']
      if (declared !== undefined && Number(declared) > maxRequestBodyBytes) {
        res.writeHead(413, { connection: 'close' }).end()
        req.destroy()
        return
      }
      const chunks: Buffer[] = []
      let received = 0
      for await (const chunk of req) {
        const buffer = chunk as Buffer
        received += buffer.byteLength
        if (received > maxRequestBodyBytes) {
          res.writeHead(413, { connection: 'close' }).end()
          req.destroy()
          return
        }
        chunks.push(buffer)
      }
      body = Buffer.concat(chunks)
    }

    const target = new URL(url.toString())
    target.pathname = url.pathname.replace(/^\/m/, '')
    // Forward string-valued headers only; drop the gate credential, the
    // hop-by-hop / recomputed ones, and the gateway's own device headers so
    // the internal request is clean.
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== 'string') continue
      if (key === 'authorization' || key === 'host' || key === 'connection' || key === 'content-length') continue
      if (key === 'x-dsh-device' || key === 'x-dsh-device-name') continue
      headers[key] = value
    }
    const internal = new Request(target, {
      method: req.method ?? 'GET',
      headers,
      ...body !== undefined && body.byteLength > 0 ? { body } : {},
      signal: abort.signal,
    })

    const response = await carrier.fetch(internal)

    // The catalog rewrite buffers the (small) JSON body, annotates model
    // entries with their input modalities, and fixes the content-length; the
    // enricher is fail-open and answers with the original text on any doubt.
    const enricher = segment === ENRICHED_METHOD ? state.enrichModelCatalog() : null
    if (enricher !== null && response.status === 200) {
      const upstreamHeaders = Object.fromEntries(response.headers.entries())
      if (String(upstreamHeaders['content-type'] ?? '').includes('json')) {
        const original = await response.text()
        const rewritten = await enricher(original)
        if (rewritten !== original) upstreamHeaders['content-length'] = String(Buffer.byteLength(rewritten))
        res.writeHead(response.status, upstreamHeaders)
        res.end(rewritten)
        return
      }
    }

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    if (response.body === null) {
      res.end()
      return
    }
    for await (const chunk of response.body) {
      // Backpressure: a false return means the socket buffer is full — wait
      // for drain instead of buffering unboundedly (slow SSE consumers).
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.once('drain', done)
          res.once('close', done)
        })
      }
    }
    res.end()
  }
}
