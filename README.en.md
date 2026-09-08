# dsh-mobile-gateway

[中文](README.md) | English

> LAN access plugin for the official DeepSeek Harness (DSH): install one
> plugin, connect the mobile app. No dsh source modifications, no fork, no
> rebuild — `dsh plugin` to install, plain `dsh web` to run.

## What it does

Official `dsh web` listens on `127.0.0.1` only, and the official CLI refuses
`--host 0.0.0.0`. This plugin opens LAN access using official extension points
only. **Full usage guide (with the mobile app): [USAGE.en.md](USAGE.en.md).**

| Concern | Mechanism |
| --- | --- |
| Bind all interfaces | The plugin's `cordis.patch.yml` overrides the `webserver` row to `host: 0.0.0.0` (`--port` still works; uninstalling restores loopback-only) |
| Close official `/api` to loopback | Binding `0.0.0.0` alone auto-trusts every LAN IP (SDK behavior, effectively unauthenticated) — the plugin sets `trustedHosts: []`; the local browser is unaffected and `--trusted-host` is inert |
| RPC surface for the phone | A token-gated `/m/api` prefix route next to the official `/api`; admitted requests are forwarded in-process to the official `apiProxy` via `toFetchHandler` |
| Live events | `/m/api/events.mux` and `/m/api/events.host` WebSocket downlinks, frame-identical to the official ones |
| Approvals / questions | `/m/api/respond` passes through to the official respond channel |
| Large images | Raises attachment limits and the request-body cap together |
| Management page `/m/` | Loopback-only: one-click token generation/rotation (live via the settings seam, persisted), per-address pairing QR codes, device list with per-device block |
| Sidebar entry | A phone icon beside Settings in the desktop Web GUI opens the management page as an **in-page modal** (with a one-click full-tab affordance; v0.3.3+, toggle with `uiEntry`) |
| Scan-to-pair | QR encodes `server\|token`; the companion app (v1.0.36+) fills both fields from one scan |

## Quick start

```sh
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add github:elskly-cmyk/dsh-mobile-gateway
#   first git install: pnpm asks to allow this package's build script —
#   accept the dsh prompt once. Dev checkout: add link:<repo path> instead.
# set the token (see below), then:
dsh web
# dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)
```

Configure the token in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: mobile-gateway
  config:
    token: a-long-random-secret
    allowSettings: true        # default
    allowCredentials: true     # default
    extraMethods: []
    maxRequestBodyBytes: 750000000
```

or through the Web GUI settings card (hot-reloads).

The app only changes its path prefix (`/api` → `/m/api`, including both
WebSocket downlinks); token, envelopes, frame formats, and rpcId correlation
are unchanged.

## Security notes

- The token is the key: anyone holding it gets the full whitelisted agent
  capability (sessions that can run commands on your machine). Use a long
  random secret.
- The boundary is your LAN. No public tunnel is included; if you need remote
  access, put an authenticated tunnel in front and make sure it passes
  WebSockets.
- Never add `--trusted-host` for this setup: it exposes the official `/api`
  to the LAN and bypasses this plugin's whitelist.

## Compatibility

Verified against `@deepseek-ai/dsh` **0.1.2-rc.1** (`dsh.engines` requires
`>=0.1.2-rc.1`). The plugin
checks the official seams at startup and fails loudly on an incompatible dsh
build instead of serving a half-broken surface.

## Development

```sh
pnpm install
pnpm test && pnpm run typecheck && pnpm run build
node scripts/e2e-ws-probe.cjs <port> <token>
```

## License

[MIT](LICENSE)
