/**
 * The /m/api method whitelist: the 0.1.2 slash endpoints a token-holding
 * caller may reach through the gateway. Everything else — including methods
 * the host loopback-pins on its own /api surface (settings, credentials,
 * agent presets, native dialogs) — is refused with 403 unless explicitly
 * enabled or listed.
 * @module
 */

/**
 * Endpoints the companion mobile app's SDK calls; always admitted after the
 * token check. `session.export` is the GET log download (read-only, same
 * visibility as `session/page`). `commands/list` and `commands/execute`
 * serve the chat header's command menu: listing is read-only catalog access
 * like `skills/list`, and execution reaches only session-scoped slash
 * commands (`/plan`, `/goal`, `/compact`, …) — a strict subset of what the
 * already admitted `session/prompt` lets a token holder do. Loopback-only
 * desktop affordances (agent presets, directory picking via
 * `directoryPicker/*` for native dialogs, `host.*` remnants) stay unlisted.
 */
export const BASE_METHODS: readonly string[] = [
  'session/list',
  'session/create',
  'session/page',
  'session/prompt',
  'session/rename',
  'session/updateQueue',
  'session/fork',
  'session/cancel',
  'session/attachment',
  'session/modelCatalog',
  'session/selectModel',
  'session/search',
  'session/export',
  'workspace/list',
  'workspace/create',
  'workspace/rename',
  'workspace/delete',
  'workspace/archiveSession',
  // Workspace-path entry for the app's add-workspace flow: read-only
  // directory browsing plus child-folder creation under a browsed parent.
  'directoryPicker/list',
  'directoryPicker/createDirectory',
  'subagents/list',
  'subagents/prompt',
  'subagents/interruptByParent',
  'goals/create',
  'goals/edit',
  'goals/complete',
  'goals/clear',
  'goals/pause',
  'goals/resume',
  'skills/list',
  'commands/list',
  'commands/execute',
  'llm/discoverModels',
  'llm/listProviders',
]

/** Configuration-plane endpoints; admitted only when `allowSettings` is on. */
export const SETTINGS_METHODS: readonly string[] = [
  'settings/describe',
  'settings/update',
  'settings/replace',
  'settings/mutate',
]

/** Secret-store endpoints; admitted only when `allowCredentials` is on. */
export const CREDENTIALS_METHODS: readonly string[] = [
  'credentials/describe',
  'credentials/set',
  'credentials/unset',
]

/**
 * The answerable-interaction reply channel (`0.1.1`'s `respond`): admitted
 * without a whitelist entry because it only completes a delivery the host
 * itself initiated after the token gate admitted the stream.
 */
export const RESPOND_ENDPOINT = '$events/result'

/** The whitelist-resolution inputs (a subset of the plugin config). */
export interface WhitelistConfig {
  allowSettings: boolean
  allowCredentials: boolean
  extraMethods: readonly string[]
}

/**
 * Resolve the final admission set from the toggles plus caller-declared
 * extras. Extras are taken verbatim; an extra naming a method the host does
 * not serve simply never matches a real route.
 * @param config - the whitelist toggles and extra method names.
 * @returns the read-only admission set.
 */
export function resolveWhitelist(config: WhitelistConfig): ReadonlySet<string> {
  return new Set([
    ...BASE_METHODS,
    ...(config.allowSettings ? SETTINGS_METHODS : []),
    ...(config.allowCredentials ? CREDENTIALS_METHODS : []),
    ...config.extraMethods,
  ])
}
