# dsh-mobile-gateway Usage Guide

> Complete guide for the companion mobile app. The server side needs only the
> official dsh plus this plugin — no source checkout, no patching, no rebuild.

中文 | [English](USAGE.en.md)

---

## Architecture

```
┌───────────────────── Your PC (same Wi-Fi / LAN) ─────────────────────┐
│  Official dsh web (npm-installed, unmodified)                        │
│  ├─ /api      official surface — loopback only; local browser works  │
│  └─ /m/api    this plugin — LAN-reachable, Bearer token required     │
│        ├─ whitelisted session/workspace/model RPCs                   │
│        ├─ /m/api/respond         approval & question answers         │
│        └─ /m/api/events.mux|.host two WebSocket event downlinks      │
└──────────────────────────────▲───────────────────────────────────────┘
                               │ Wi-Fi (LAN HTTP + token auth)
                        ┌──────┴──────┐
                        │  Mobile app │  URL: http://<pc-ip>:<port>
                        └─────────────┘  token: same as plugin config
```

## Server: three steps

**1. Install the plugin**

```sh
dsh plugin --profile web add github:elslky-cmyk/dsh-mobile-gateway
#   first git install: accept the build-script prompt (allowBuilds) that dsh
#   prints. Dev checkout: dsh plugin --profile web add link:<repo path>
```

**2. Configure the token**

Skip this step if you like: after starting, open
`http://127.0.0.1:3080/m/` in the PC's browser and click “生成新 token”
(generate) — see the management page below. Manual alternative: generate a
long random secret (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
then either edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: mobile-gateway
  config:
    token: your-long-random-secret
```

(restart `dsh web` to apply) or use the Web GUI settings card at
`http://127.0.0.1:3080` → Settings → Plugin config → mobile-gateway (hot-reloads).
An empty token means unpaired: `/m/api` refuses every caller and the
management page shows a red banner — pairing starts there.

**3. Start**

```sh
dsh web
```

No flags. The plugin binds all interfaces, prints the LAN URL
(`dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)`), and closes
the official `/api` to loopback (the local browser is unaffected; LAN callers
get 403). Allow Node.js inbound on the first-run firewall prompt.

## Management page

Open `http://127.0.0.1:3080/m/` **on the PC itself** — or click the **phone
icon beside Settings** at the sidebar foot of the desktop Web GUI: the
management page opens as an **in-page modal** (close with Esc, the close
button, or a backdrop click; a “新标签页” affordance switches to a full
browser tab; v0.3.0+, hide the icon with the `uiEntry: false` setting). A LAN
address gets 403 — the token never renders off-machine. The page shows the current token, generates
per-address pairing QR codes (one per LAN IPv4), rotates the token in one
click (live: old tokens stop working on their next request, no restart, and
the new one persists in `~/.dsh/settings.yaml`), and lists connected devices
(name, online state, last activity) with per-device block/unblock. Blocking
takes effect on the device's next request and clears on restart; rotating the
token is the durable kill.

## Phone: install & connect

- Install the APK from GitHub Releases (**v1.0.36 or newer** — this version
  speaks the plugin's `/m/api` and supports scan-to-pair; older APKs used
  `/api` and will not work), or build from source with
  `flutter build apk --release`.
- Scan-to-pair: same Wi-Fi as the PC → app's “扫码配对” button → point at a
  QR on the management page → both fields fill automatically.
- Or manual entry: the `LAN:` URL plus the token. The app validates with
  `host.describe` and remembers both.
- The server address must not contain spaces (they URL-encode to `%20` and
  break host parsing).

## App features

Session drawer grouped by workspace (auto-expanding running groups) · streaming
chat with collapsible reasoning and Markdown · tool-call tree with detail
drawer · approval cards and question sheets answered from the phone · model
and reasoning-effort switching · permission presets · goal/plan/todo
projections · queue & cancel · background jobs · subagents · full-text search ·
session log export · read-only settings pages · light/dark/system theme ·
automatic reconnect with live status.

## Configuration reference

```yaml
- id: mobile-gateway
  config:
    token: <required>
    allowSettings: true        # settings.* read/write (app settings page)
    allowCredentials: true     # credentials.* management
    extraMethods: []           # e.g. ['subagent.history']
    maxRequestBodyBytes: 750000000
```

Always refused: `host.pickDirectory/openPath`, `llm.discoverModels`,
`agentPreset.*` management. Append explicitly via `extraMethods` if needed.

## Security model

- The token is the only key (constant-time compare). Holders get the full
  whitelisted agent capability — use a ≥32-byte random secret.
- The plugin closes the official `/api` to loopback; binding `0.0.0.0` alone
  would auto-trust every LAN IP (SDK behavior) and expose `/api` unauthenticated.
  `--trusted-host` is intentionally inert under this plugin — never restore it.
- Boundary is your LAN; add an authenticated tunnel (that passes WebSockets)
  for remote access. Traffic is plaintext HTTP.
- Revoke access by rotating the token (hot) or removing the plugin and restarting.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| 401 on connect | token mismatch — re-scan or update the token after rotating on /m/ |
| 403 on connect | device blocked (unblock on /m/), method not whitelisted, or app older than v1.0.36 (still on `/api`) |
| Management page 403 | opened from a LAN address — use `http://127.0.0.1:<port>/m/` on the PC itself |
| Timeout | different Wi-Fi; firewall blocks Node inbound; address must be the PC's LAN IP, not 127.0.0.1 |
| "invalid server address" | missing `http://` or spaces in the URL |
| Settings page errors | `allowSettings`/`allowCredentials` disabled, or old app version |
| "apiProxy service lacks the required seams" | dsh build incompatible with this plugin version |

## Verified

`@deepseek-ai/dsh@0.1.1-rc.2` (npm latest) · Node 24 · Windows server ·
Android device · full path exercised (auth, sessions, streaming, approvals,
WebSocket events, log export).
