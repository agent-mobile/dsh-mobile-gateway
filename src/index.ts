/**
 * dsh-mobile-gateway — LAN access for the DSH mobile app.
 *
 * One host-side Cordis plugin. Its patch layer binds the dsh web server to
 * all interfaces and raises the attachment/body caps; the plugin itself
 * mounts a token-gated `/m/api` surface next to the host's own loopback-pinned
 * `/api`: every HTTP request passes a constant-time bearer check and an
 * endpoint whitelist before being rewritten onto the host's shared `/api`
 * fetch carrier (the Typert remote interceptor over the
 * `toFetchHandler(apiProxy)` fallback — the same dispatch chain the host's
 * own `/api` route uses, so remote endpoints such as `commands/*` reach
 * their dispatchers). The phone's one 0.1.2 event socket, `/m/api/remote.mux`,
 * is served by the vendored Remote mux whose open callback is the host
 * `typertGateway` service's public `wireStream` — the phone's `$events` and
 * `session/follow` streams land in the same host-side registries the desktop
 * browser uses, and `$events/result` replies ride the HTTP route below.
 *
 * The gateway's config is also a live settings namespace (`mobile-gateway`):
 * rotating the token through the settings seam (the management page's
 * generate button, the Web GUI settings card, or `settings/update`) swaps the
 * admission gate on the fly — no restart, and older tokens stop working on
 * their next request. The loopback-only management page at `/m/` renders
 * connection info, pairing QR codes, and the device ledger.
 *
 * No dsh source modifications: the seams this plugin uses (webServer route
 * registration, the apiProxy service, the fetch carrier, the typertGateway
 * wireStream, the settings seam) are the official npm packages' public exports.
 * @module dsh-mobile-gateway
 */

import { createRequire } from 'node:module'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the SettingsProvider Context merge (ctx.settings).
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: pulls the LlmRuntime Context merge (ctx.llm) for catalog
// capability discovery.
import type {} from '@deepseek-ai/dsh-llm'
import { createCatalogEnricher } from './catalog.ts'
import { createBearerGate } from './gate.ts'
import { resolveWhitelist } from './whitelist.ts'
import { createRouteHandler, type GatewayState } from './route.ts'
import { GatewayRemoteMux, rejectUnauthorizedUpgrade, resolveWireStream } from './remote-mux.ts'
import { DeviceTracker, extractIdentity } from './devices.ts'
import { registerAdminRoutes, SETTINGS_NS } from './admin.ts'

/** Stable Cordis plugin name (also the settings namespace id). */
export const name = 'mobile-gateway'

/** Services required before the gateway can mount (route registration needs both). */
export const inject = ['webServer', 'connection']

/** Plugin config (entry layer; the user layer over it is live-editable). */
export interface Config {
  /**
   * Shared secret the mobile app presents as `Authorization: Bearer <token>`.
   * Empty = unpaired (all requests refused). Carries the settings seam's
   * `secret` role so wire surfaces (settings.describe, the client settings
   * scope) redact it; the in-process owner scope and the loopback management
   * page still read the real value.
   */
  token: string
  /** Admit the settings plane (default on — the app has a settings page). */
  allowSettings: boolean
  /** Admit the credentials plane (default on — the app has a credentials page). */
  allowCredentials: boolean
  /** Show the sidebar entry (phone icon beside Settings) on the desktop Web GUI; `/m/` itself stays reachable. */
  uiEntry: boolean
  /** Extra RPC methods admitted verbatim on top of the built-in whitelist. */
  extraMethods: string[]
  /**
   * Model ids to advertise as image-capable when the host LLM runtime cannot
   * say (absent runtime, or a model that declares no input modalities).
   * Discovery from the runtime itself always wins; this is the escape hatch.
   */
  visionModels: string[]
  /** Per-request body cap for /m/api (keep ≥ the connection row's cap). */
  maxRequestBodyBytes: number
}

export const Config: z<Config> = z.object({
  token: z.string().role('secret').default(''),
  allowSettings: z.boolean().default(true),
  allowCredentials: z.boolean().default(true),
  uiEntry: z.boolean().default(true),
  extraMethods: z.array(String).default([]),
  visionModels: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().default(750_000_000),
})

/** Resolve an entry config with every default filled (hand-built contexts may pass none). */
function resolveEntry(config?: Config): Config {
  return {
    token: config?.token ?? '',
    allowSettings: config?.allowSettings ?? true,
    allowCredentials: config?.allowCredentials ?? true,
    uiEntry: config?.uiEntry ?? true,
    extraMethods: config?.extraMethods ?? [],
    visionModels: config?.visionModels ?? [],
    maxRequestBodyBytes: config?.maxRequestBodyBytes ?? 750_000_000,
  }
}

/** This plugin's own package version, for the management page header. */
function pluginVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    return String(require('../package.json').version)
  } catch {
    return 'unknown'
  }
}

/**
 * Fail loud when the host's connection does not expose the shared fetch carrier
 * this plugin forwards through — an incompatible dsh build must refuse to boot
 * the gateway, not serve a half-working surface.
 * @param connection - the host ConnectionFetchHandler source.
 */
function assertCarrierSeams(connection: ConnectionFetchHandler): void {
  if (typeof connection.fetch !== 'function') {
    throw new Error(
      'mobile-gateway: this dsh build\'s connection lacks the shared /api fetch carrier '
      + 'required to forward /m/api; the installed dsh version is likely '
      + 'incompatible with this plugin (supported: @deepseek-ai/dsh >= 0.1.2-rc.1)',
    )
  }
}

/**
 * Mount the gateway: the /m/api prefix route, the two upgrade routes, and the
 * loopback management surface. Token and whitelist toggles live in the
 * `mobile-gateway` settings namespace and apply on commit.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied by the
 * Loader; hand-built contexts may pass none).
 */
export function apply(ctx: Context, config?: Config): void {
  const entry = resolveEntry(config)

  // Live state: rebuilt whenever the settings namespace commits a change.
  const state: GatewayState = {
    gate: () => createBearerGate(entry.token),
    whitelist: () => resolveWhitelist(entry),
    maxRequestBodyBytes: () => entry.maxRequestBodyBytes,
    enrichModelCatalog: () => null,
  }
  const tracker = new DeviceTracker()
  let source: () => Config = () => entry
  const applyResolved = (resolved: Config): void => {
    state.gate = () => createBearerGate(resolved.token)
    state.whitelist = () => resolveWhitelist(resolved)
    state.maxRequestBodyBytes = () => resolved.maxRequestBodyBytes
    if (resolved.token.trim() === '') {
      ctx.logger.warn('mobile-gateway: no token configured — /m/api refuses every caller until one is set (generate one at /m/)')
    } else {
      ctx.logger.info(
        `mobile-gateway: /m/api active (allowSettings=${String(resolved.allowSettings)}, `
        + `allowCredentials=${String(resolved.allowCredentials)}), management page at /m/`,
      )
    }
  }

  // The settings namespace: composition entry as base, user layer above,
  // commits swap the gate live. Without a settings service (test contexts)
  // the source stays the entry and nothing degrades.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, entry, {
      setSource: (next) => {
        source = next
      },
      onChange: () => applyResolved(source()),
    })
  })

  // Model capability discovery for the catalog enrichment. Optional on
  // purpose: where the host does not expose the llm runtime (test contexts)
  // this callback never runs, `enrichModelCatalog` stays null, and catalog
  // responses pass through unannotated.
  ctx.inject(['llm'], (llmCtx) => {
    state.enrichModelCatalog = () => createCatalogEnricher({
      llm: llmCtx.llm,
      visionModels: () => source().visionModels,
    })
  })

  ctx.inject(['connection'], (connCtx) => {
    // The host's shared /api dispatch chain. The bearer gate and endpoint
    // whitelist remain this surface's admission boundary.
    const carrier = connCtx.connection.createSharedFetchHandler('/api')
    assertCarrierSeams(carrier)
    connCtx.effect(() => connCtx.webServer.register({
      kind: 'prefix',
      path: '/m/api',
      handler: createRouteHandler({ state, tracker, carrier }),
    }), 'mobile-gateway: /m/api route')

    // The phone's single 0.1.2 event socket. Resolution is lazy so a plugin
    // that boots before the api-gateway still composes; a stream opening
    // without the service fails loud with the descriptive resolver error.
    const mux = new GatewayRemoteMux(() => resolveWireStream(connCtx))
    const upgradePath = '/m/api/remote.mux'
    const route = {
      path: upgradePath,
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const identity = extractIdentity(req.headers, req.socket?.remoteAddress)
        if (!state.gate().check(req.headers) || tracker.isBlocked(identity.id)) {
          rejectUnauthorizedUpgrade(socket)
          return
        }
        tracker.streamDelta(identity, 1)
        socket.once('close', () => { tracker.streamDelta(identity, -1) })
        mux.handle(req, socket, head)
      },
    }
    connCtx.effect(() => connCtx.webServer.registerUpgrade(route), `mobile-gateway: ${upgradePath} upgrade`)
    connCtx.effect(() => async () => {
      await mux.close()
    }, 'mobile-gateway: remote mux')

    registerAdminRoutes(connCtx, { source, version: pluginVersion(), tracker })
  })
}
