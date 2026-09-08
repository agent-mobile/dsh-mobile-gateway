/**
 * REAL-composition coverage: the real WebServer plugin plus a real
 * HostConnectionService (whose shared /api carrier the gateway rewrites onto),
 * with the gateway plugin loaded on top. Every assertion observes the
 * user-visible HTTP and WebSocket surface of the running server. The host
 * `typertGateway` service is a controlled fake, so the remote.mux assertions
 * observe the gateway's framing and pumping, not the host's stream logic.
 */

import { once } from 'node:events'
import { request as requestRaw } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import WebSocket from 'ws'
import { apply, type Config } from '../src/index.ts'

const TOKEN = 'test-secret'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let context: Context | undefined
let settingsDir: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (settingsDir !== undefined) await rm(settingsDir, { recursive: true, force: true })
  settingsDir = undefined
})

/**
 * A fake host `typertGateway` wireStream. `$events` opens into a ready frame
 * plus a pull-driven queue the test fills; any other endpoint yields two
 * numbered items and ends. The generator is abort-aware, matching the real
 * host stream lifetimes the mux's close path relies on.
 */
class FakeWireStream {
  readonly opened: { endpoint: string, payload: unknown }[] = []
  readonly cancelled: string[] = []
  private readonly queue: unknown[] = []
  private readonly waiters: (() => void)[] = []

  /** Push one `$events` item to the next pending generator read. */
  push(frame: unknown): void {
    this.queue.push(frame)
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  readonly wireStream = {
    open: async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> => {
      this.opened.push({ endpoint, payload })
      signal.addEventListener('abort', () => { this.cancelled.push(endpoint) }, { once: true })
      if (endpoint !== '$events') {
        return (async function* () {
          yield { index: 1 }
          yield { index: 2 }
        })()
      }
      const self = this
      return (async function* () {
        yield { type: 'ready', clientId: 'client-1', host: { home: '' } }
        while (!signal.aborted) {
          const next = await self.waitForItem(signal)
          if (signal.aborted) return
          yield next
        }
      })()
    },
    failure: (error: unknown) => ({ code: 'test/failure', message: String(error), details: {} }),
  }

  /** Next queued item, or undefined when the signal aborts. */
  private waitForItem(signal: AbortSignal): Promise<unknown> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolve) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(undefined)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(this.queue.shift())
      })
    })
  }
}

/** Boot webserver + settings + connection + gateway on an OS-assigned loopback port. */
async function boot(config: Partial<Config> = {}, wireStream = new FakeWireStream()): Promise<{
  port: number
  wire: FakeWireStream
}> {
  settingsDir = await mkdtemp(join(tmpdir(), 'dsh-mobile-gateway-test-settings-'))
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(FileSettingsProvider, { path: join(settingsDir, 'settings.yaml') })
  // The real connection service: its shared /api carrier is what the gateway
  // rewrites /m/api onto. Construct it directly with a stub BrowserAuth (the
  // gateway only uses createSharedFetchHandler; loopback callers are always
  // admitted, so isAuthenticated is moot here). Cast through `never`
  // (BrowserAuth is a concrete class not exported for stubbing).
  const auth = { isAuthenticated: () => true } as never
  const connection = new HostConnectionService(context, ['127.0.0.1'], auth)
  // One fake Typert remote claims the commands namespace to prove remote
  // endpoints reach interceptors, not just the plain RPC map; `session/list`
  // and `$events/result` mirror what the real typertGateway interceptor claims.
  // A channel seats one interceptor, so all claims share it.
  connection.rpc.intercept(
    '/api',
    endpoint => endpoint === 'commands/list' || endpoint === 'session/list' || endpoint === '$events/result',
    async (endpoint) => {
      if (endpoint === 'session/list') return { ok: true, value: { items: [] } }
      if (endpoint === '$events/result') return { ok: true, value: undefined }
      return { ok: true, value: { claimed: endpoint } }
    },
  )
  // The host typertGateway service under a controlled fake: the gateway's
  // mux pumps through it exactly as it would the real service.
  context.provide('typertGateway', { wireStream: wireStream.wireStream } as never)
  await context.plugin({ name: 'mobile-gateway', inject: ['webServer', 'connection'], apply }, {
    token: TOKEN,
    ...config,
  } as Config)
  const port = context.get('webServer')?.port
  if (port === undefined) throw new Error('webserver did not bind')
  return { port, wire: wireStream }
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Open an authorized remote.mux socket and return it with its test wire stream. */
async function openMux(port: number, wire: FakeWireStream, streamId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/m/api/remote.mux`, { headers: AUTH })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }))
  return socket
}

/** Persistent frame reader for one socket (a per-read `once` drops back-to-back frames). */
function frames(socket: WebSocket): { next(): Promise<{ type: string, streamId?: string, value?: unknown, error?: unknown }> } {
  const received: Array<{ type: string, streamId?: string, value?: unknown, error?: unknown }> = []
  const waiters: (() => void)[] = []
  socket.on('message', (data: Buffer) => {
    received.push(JSON.parse(data.toString()))
    for (const waiter of waiters.splice(0)) waiter()
  })
  return {
    async next() {
      if (received.length === 0) {
        await new Promise<void>((resolve) => { waiters.push(resolve) })
      }
      return received.shift()!
    },
  }
}

describe('mobile-gateway /m/api surface', () => {
  it('rejects a missing or wrong token with 401', async () => {
    const { port } = await boot()
    const bare = await post(port, '/m/api/session/list', {})
    expect(bare.status).toBe(401)
    const wrong = await post(port, '/m/api/session/list', {}, { authorization: 'Bearer nope' })
    expect(wrong.status).toBe(401)
  })

  it('refuses non-whitelisted endpoints with 403 even with a valid token', async () => {
    const { port } = await boot({ allowCredentials: false })
    const credentials = await post(port, '/m/api/credentials/set', {
      type: 'client-request', rpcId: 'rpc-2', method: 'credentials/set', payload: { args: {} },
    }, AUTH)
    expect(credentials.status).toBe(403)

    const desktop = await post(port, '/m/api/agentPreset/read', {
      type: 'client-request', rpcId: 'rpc-3', method: 'agentPreset/read', payload: { args: {} },
    }, AUTH)
    expect(desktop.status).toBe(403)

    const unknown = await post(port, '/m/api/does/notExist', {}, AUTH)
    expect(unknown.status).toBe(403)
  })

  it('admits whitelisted 0.1.2 endpoints end to end', async () => {
    const { port } = await boot()
    const list = await post(port, '/m/api/session/list', {
      type: 'client-request', rpcId: 'rpc-4', method: 'session/list', payload: { args: {} },
    }, AUTH)
    expect(list.status).toBe(200)
    const envelope = await list.json() as { type: string, result: { ok: boolean, value: { items: unknown[] } } }
    expect(envelope.result.ok).toBe(true)
    expect(envelope.result.value.items).toEqual([])
  })

  it('forwards whitelisted Typert remote endpoints (commands/*) through the interceptor', async () => {
    const { port } = await boot()
    const response = await post(port, '/m/api/commands/list', {
      type: 'client-request', rpcId: 'rpc-6', method: 'commands/list', payload: { args: { agentId: 's1' } },
    }, AUTH)
    expect(response.status).toBe(200)
    const envelope = await response.json() as { type: string, rpcId: string, result: { ok: boolean, value: unknown } }
    expect(envelope.type).toBe('server-response')
    expect(envelope.rpcId).toBe('rpc-6')
    expect(envelope.result.ok).toBe(true)
    expect(envelope.result.value).toEqual({ claimed: 'commands/list' })
  })

  it('admits the $events/result reply endpoint for a token holder', async () => {
    const { port } = await boot()
    // The carrier seats one interceptor whose rpcFetchHandler requires the
    // client-request envelope; the real SDK answers waterfalls with this shape.
    const response = await post(port, '/m/api/$events/result', {
      type: 'client-request', rpcId: 'rpc-7', method: '$events/result',
      payload: { clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'next' } },
    }, AUTH)
    expect(response.status).toBe(200)
    const envelope = await response.json() as { result: { ok: boolean } }
    expect(envelope.result.ok).toBe(true)
  })

  it('serves the management page and admin surface', async () => {
    const { port } = await boot()
    const page = await fetch(`http://127.0.0.1:${String(port)}/m/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('Mobile Gateway')

    const redirect = await fetch(`http://127.0.0.1:${String(port)}/m`, { redirect: 'manual' })
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('/m/')
  })
})

describe('mobile-gateway management surface (/m/)', () => {
  it('refuses every management route from a non-loopback Host', async () => {
    const { port } = await boot()
    for (const path of ['/m/', '/m/admin/info', '/m/admin/rotate', '/m/admin/device']) {
      const status = await new Promise<number>((resolve, reject) => {
        const [hostname, portText] = `127.0.0.1:${String(port)}`.split(':')
        const request = requestRaw({
          hostname: hostname!, port: Number(portText), path, method: 'GET',
          headers: { host: `192.168.1.7:${String(port)}` },
        })
        request.on('response', response => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        request.on('error', reject)
        request.end()
      })
      expect(status).toBe(403)
    }
  })

  it('tracks device identity from headers and blocks/unblocks at the route', async () => {
    const { port } = await boot()
    const deviceHeaders = { ...AUTH, 'x-dsh-device': 'phone-abc', 'x-dsh-device-name': 'Pixel 7' }
    // One admitted request wearing a device identity (any whitelisted endpoint).
    await post(port, '/m/api/commands/list', { type: 'client-request', rpcId: 'd1', method: 'commands/list', payload: { args: {} } }, deviceHeaders)
    const info = await (await fetch(`http://127.0.0.1:${String(port)}/m/admin/info`)).json() as {
      token: string, tokenConfigured: boolean, tokenQrSafe: boolean,
      devices: { id: string, name: string, requests: number, blocked: boolean }[],
    }
    expect(info.token).toBe(TOKEN)
    expect(info.tokenConfigured).toBe(true)
    expect(info.devices.some(device => device.id === 'dev:phone-abc' && device.name === 'Pixel 7' && device.requests >= 1)).toBe(true)

    const block = await fetch(`http://127.0.0.1:${String(port)}/m/admin/device`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'dev:phone-abc', blocked: true }),
    })
    expect(block.status).toBe(200)
    // A blocked device is refused at the /m/api route (403).
    const refused = await post(port, '/m/api/commands/list', { type: 'client-request', rpcId: 'd2', method: 'commands/list', payload: { args: {} } }, deviceHeaders)
    expect(refused.status).toBe(403)
  })

  it('rotate generates a fresh token and writes it through settings update', async () => {
    const { port } = await boot()
    const before = await (await fetch(`http://127.0.0.1:${String(port)}/m/admin/info`)).json() as { token: string }
    const response = await fetch(`http://127.0.0.1:${String(port)}/m/admin/rotate`, { method: 'POST' })
    expect(response.status).toBe(200)
    const out = await response.json() as { ok: boolean, token: string }
    expect(out.ok).toBe(true)
    expect(out.token).toMatch(/^[0-9a-f]{64}$/)
    expect(out.token).not.toBe(before.token)
    // The rotation persisted to the settings namespace (read back live).
    const after = await (await fetch(`http://127.0.0.1:${String(port)}/m/admin/info`)).json() as { token: string }
    expect(after.token).toBe(out.token)
  })

  it('refuses every /m/api caller while unpaired (empty token)', async () => {
    const { port } = await boot({ token: '' })
    const response = await post(port, '/m/api/commands/list', {
      type: 'client-request', rpcId: 'r1', method: 'commands/list', payload: { args: {} },
    }, { authorization: '' })
    expect(response.status).toBe(401)
    const info = await (await fetch(`http://127.0.0.1:${String(port)}/m/admin/info`)).json() as { tokenConfigured: boolean }
    expect(info.tokenConfigured).toBe(false)
  })
})

describe('mobile-gateway /m/api/remote.mux', () => {
  it('rejects an unauthorized upgrade with a raw 403', async () => {
    const { port } = await boot()
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/m/api/remote.mux`)
    const status = await new Promise<number | undefined>((resolve) => {
      socket.on('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode)
      })
    })
    expect(status).toBe(403)
  })

  it('pumps $events ready + pushed frames for an opened logical stream', async () => {
    const { port, wire } = await boot()
    const socket = await openMux(port, wire, 's1')
    const stream = frames(socket)

    // The fake wireStream opens $events with the ready frame.
    const ready = await stream.next()
    expect(ready).toEqual({
      type: 'item', streamId: 's1',
      value: { type: 'ready', clientId: 'client-1', host: { home: '' } },
    })

    // A pushed application frame crosses as an item on the same stream.
    wire.push({ type: 'emit', event: 'test/event', args: ['arg-a', 'arg-b'] })
    const emit = await stream.next()
    expect(emit).toEqual({
      type: 'item', streamId: 's1',
      value: { type: 'emit', event: 'test/event', args: ['arg-a', 'arg-b'] },
    })
    expect(wire.opened).toEqual([{ endpoint: '$events', payload: { args: {} } }])
    socket.close()
  })

  it('multiplexes a second logical stream and delivers items then end', async () => {
    const { port, wire } = await boot()
    const socket = await openMux(port, wire, 's1')
    const stream = frames(socket)
    await stream.next() // $events ready frame

    // A plain stream on the same socket: items then end-of-stream.
    socket.send(JSON.stringify({ type: 'open', streamId: 's2', endpoint: 'test/values', payload: { args: { address: { kind: 'session', sessionId: 'x' } } } }))
    const first = await stream.next()
    expect(first).toEqual({ type: 'item', streamId: 's2', value: { index: 1 } })
    const second = await stream.next()
    expect(second).toEqual({ type: 'item', streamId: 's2', value: { index: 2 } })
    const end = await stream.next()
    expect(end).toEqual({ type: 'end', streamId: 's2' })
    expect(wire.opened.map(entry => entry.endpoint)).toEqual(['$events', 'test/values'])
    socket.close()
  })

  it('cancels a logical stream on a cancel frame', async () => {
    const { port, wire } = await boot()
    const socket = await openMux(port, wire, 's1')
    const stream = frames(socket)
    await stream.next() // ready frame
    socket.send(JSON.stringify({ type: 'cancel', streamId: 's1' }))
    // The cancel reaches the fake opener's abort signal without an end frame
    // (aborted streams send nothing).
    const deadline = Date.now() + 2000
    while (wire.cancelled.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(wire.cancelled).toEqual(['$events'])
    socket.close()
  })
})
