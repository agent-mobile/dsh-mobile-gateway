/**
 * Browser half: the sidebar-foot entry (a phone icon beside the Settings
 * trigger) that opens the loopback management page at `/m/`.
 *
 * The entry registers into the ui-sidebar-declared `sidebar.footer.action`
 * list seat, declaration-aware through `slots.inject`. It never registers on
 * a non-loopback origin (the management page refuses those with 403) and its
 * registration follows the `uiEntry` setting in the host namespace — turning
 * the setting off in the settings card removes the trigger without a reload.
 *
 * Export discipline: only what cordis loading needs.
 * @module dsh-mobile-gateway/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-settings Context merge (ctx.settingsScope) and the
// settings-surface contract.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the 'sidebar.footer.action' hole).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { FooterGatewayEntry } from './footer-entry.tsx'

/** Stable Cordis plugin name (the browser half of the same plugin row). */
export const name = 'mobile-gateway-client'

/** Services required before the entry can register. */
export const inject = ['slots', 'settingsScope']

/** The settings namespace the host half registers (token rides role('secret') redaction). */
const SETTINGS_NS = 'mobile-gateway'

/** The namespace fields this half reads. */
interface GatewaySettings {
  uiEntry?: boolean
}

/**
 * Loopback hostname check mirroring the host half's admin guard: `localhost`,
 * IPv6 loopback, or any IPv4 address in 127/8.
 * @param hostname - the current page's hostname.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return v4 !== null && v4[1] === '127' && v4.slice(2).every(part => Number(part) <= 255)
}

/**
 * Register the sidebar entry: declaration-aware, gated by the origin being
 * loopback and by the `uiEntry` setting (hot on/off via the scope).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // The management page is loopback-only; on any other origin the button
  // would open a 403, so the entry never registers there.
  if (!isLoopbackHostname(window.location.hostname)) return

  const scope = ctx.settingsScope.bind<GatewaySettings>({ namespace: SETTINGS_NS })
  const enabled = (): boolean => {
    const snapshot = scope.getSnapshot()
    return snapshot.status === 'ready' ? snapshot.value?.uiEntry !== false : true
  }

  ctx.slots.inject('sidebar.footer.action', () => {
    let disposeEntry: (() => void) | undefined
    const syncEntry = (): void => {
      if (enabled() && disposeEntry === undefined) {
        disposeEntry = ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'mobile-gateway' },
          FooterGatewayEntry,
        )
      } else if (!enabled() && disposeEntry !== undefined) {
        disposeEntry()
        disposeEntry = undefined
      }
    }
    const unsubscribe = scope.subscribe(syncEntry)
    syncEntry()
    return () => {
      unsubscribe()
      disposeEntry?.()
    }
  })
}
