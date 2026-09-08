/**
 * The loopback-only management surface: the pairing page at `/m/` plus its
 * JSON endpoints under `/m/admin/*`. The page shows connection info, the
 * current token, per-address pairing QR codes, and the device ledger; its
 * actions are token rotation (through the official settings namespace, which
 * live-applies) and per-device block/unblock. Every route refuses non-loopback
 * Hosts — the token is the pairing secret and never renders off-machine.
 * @module
 */

import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import qrcode from 'qrcode-generator'
import type { Context } from '@deepseek-ai/cordis'
import { isLoopbackRequest } from './loopback.ts'
import type { DeviceTracker, DeviceSnapshot } from './devices.ts'
import type { Config } from './index.ts'

/** The settings namespace the gateway's config registers under. */
export const SETTINGS_NS = 'mobile-gateway'

/** Constructor inputs for the management routes. */
export interface AdminOptions {
  /** Reads the gateway's current resolved config (live through settings). */
  source: () => Config
  /** Plugin version rendered in the page header. */
  version: string
  /** The device ledger shared with the /m/api route. */
  tracker: DeviceTracker
}

/** One QR pairing card in the info payload. */
interface QrCard {
  /** The LAN address the payload connects to. */
  ip: string
  /** Full origin URL for that address. */
  url: string
  /** What the QR encodes: `<url>|<token>`, the app's scan format. */
  payload: string
  /** Compact SVG rendering of the QR. */
  svg: string
}

/** The `/m/admin/info` payload. */
export interface AdminInfo {
  version: string
  port: number
  token: string
  tokenConfigured: boolean
  /** False when the token contains the scan-format separator and QR pairing cannot encode it. */
  tokenQrSafe: boolean
  allowSettings: boolean
  allowCredentials: boolean
  lanAddresses: string[]
  qrs: QrCard[]
  devices: DeviceSnapshot[]
}

/**
 * Render one payload as a compact single-path SVG QR (about 1 KB per code).
 * @param payload - the string the code carries.
 * @returns an SVG document string.
 */
export function renderQrSvg(payload: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  const count = qr.getModuleCount()
  let path = ''
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${String(col)} ${String(row)}h1v1h-1z`
    }
  }
  const size = count + 8
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 '
    + `${String(size)} ${String(size)}" shape-rendering="crispEdges" role="img">`
    + `<rect x="-4" y="-4" width="${String(size)}" height="${String(size)}" fill="#ffffff"/>`
    + `<path d="${path}" fill="#000000"/></svg>`
}

/** Non-internal IPv4 literals of this machine, in interface order. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((iface): iface is NonNullable<typeof iface> =>
      iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** Read and parse one JSON request body; undefined on malformed input. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Register the management routes on the webserver. Loopback-only; the
 * dispositions write a short explanation so a LAN browser learns why.
 * @param ctx - context carrying webServer and apiProxy.
 * @param options - config source, version, and the shared device ledger.
 */
export function registerAdminRoutes(ctx: Context, options: AdminOptions): void {
  const refuse = (res: ServerResponse): void => {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('管理页仅限本机访问：请在 http://127.0.0.1 打开 /m/')
  }
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isLoopbackRequest(req.headers)) return true
    refuse(res)
    return false
  }

  const infoOf = (): AdminInfo => {
    const config = options.source()
    const port = ctx.webServer.port
    const addresses = lanAddresses()
    const token = config.token
    const urls = addresses.map(ip => `http://${ip}:${String(port)}`)
    const tokenQrSafe = !token.includes('|')
    return {
      version: options.version,
      port,
      token,
      tokenConfigured: token.trim() !== '',
      tokenQrSafe,
      allowSettings: config.allowSettings,
      allowCredentials: config.allowCredentials,
      lanAddresses: addresses,
      qrs: tokenQrSafe && token.trim() !== ''
        ? addresses.map((ip, index) => {
          const url = urls[index]!
          const payload = `${url}|${token}`
          return { ip, url, payload, svg: renderQrSvg(payload) }
        })
        : [],
      devices: options.tracker.snapshot(),
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m', handler: (_req, res) => {
    res.writeHead(301, { location: '/m/' })
    res.end()
  } }), 'mobile-gateway: /m redirect')

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m/', handler: (req, res) => {
    if (!guard(req, res)) return
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(managementPage())
  } }), 'mobile-gateway: management page')

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m/admin/info', handler: (req, res) => {
    if (!guard(req, res)) return
    sendJson(res, 200, infoOf())
  } }), 'mobile-gateway: admin info')

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m/admin/rotate', handler: async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST required' })
      return
    }
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.update !== 'function') {
      sendJson(res, 503, { ok: false, error: 'settings 服务不可用：无法轮换 token（可用 Web 设置卡手动修改）' })
      return
    }
    const token = randomBytes(32).toString('hex')
    try {
      await settings.update(SETTINGS_NS, { token })
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    sendJson(res, 200, { ok: true, token })
  } }), 'mobile-gateway: admin rotate')

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/m/admin/device', handler: async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST required' })
      return
    }
    const body = await readJsonBody(req) as { id?: unknown, blocked?: unknown } | undefined
    if (body === undefined || typeof body.id !== 'string' || typeof body.blocked !== 'boolean') {
      sendJson(res, 400, { ok: false, error: 'body must be {"id": string, "blocked": boolean}' })
      return
    }
    options.tracker.setBlocked(body.id, body.blocked)
    sendJson(res, 200, { ok: true })
  } }), 'mobile-gateway: admin device')
}

/** The pairing/management page: connection info, token, QR cards, devices. */
function managementPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mobile Gateway 管理页</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 system-ui, "Segoe UI", sans-serif; padding: 24px; max-width: 980px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 20px; }
  section { border: 1px solid #4444; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; font-weight: 600; }
  .banner.warn { background: #d64545; color: #fff; }
  .banner.hint { background: #2f6fed; color: #fff; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 6px 0; }
  code { background: #8882; padding: 2px 7px; border-radius: 5px; font-size: 13px; word-break: break-all; }
  button { font: inherit; padding: 5px 14px; border-radius: 7px; border: 1px solid #8886; cursor: pointer; background: #8881; }
  button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
  button.danger { background: #d64545; border-color: #d64545; color: #fff; }
  .qr-grid { display: flex; gap: 18px; flex-wrap: wrap; }
  .qr-card { text-align: center; border: 1px solid #4444; border-radius: 10px; padding: 14px; min-width: 190px; }
  .qr-card svg { width: 170px; height: 170px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #4443; font-size: 13px; }
  th { color: #888; font-weight: 600; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 99px; font-size: 12px; }
  .pill.on { background: #1d9a5f2b; color: #1d9a5f; }
  .pill.off { background: #8883; color: #888; }
  .pill.blocked { background: #d645452b; color: #d64545; }
  .muted { color: #888; }
  .mono { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<h1>Mobile Gateway 管理页</h1>
<div class="sub">dsh-mobile-gateway · 仅本机可访问 · 手机 App 配对与管理</div>

<div id="banner"></div>

<section>
  <h2>访问令牌</h2>
  <div class="row"><code id="token" class="mono">加载中…</code></div>
  <div class="row">
    <button id="toggle">显示</button>
    <button id="rotate" class="danger">生成新 token</button>
    <span class="muted">轮换后所有旧连接立即失效（热生效，无需重启）</span>
  </div>
</section>

<section>
  <h2>扫码配对</h2>
  <div id="qr-hint" class="muted">手机 App 连接页点「扫码」，对准任一二维码即可自动填入地址与令牌。App 也可手动输入：地址填下方 URL，令牌填上方 token。</div>
  <div id="qrs" class="qr-grid" style="margin-top:12px"></div>
</section>

<section>
  <h2>已连接设备</h2>
  <div class="muted" style="margin-bottom:8px">屏蔽在下一次请求生效、重启后清除；要永久踢出全部设备请轮换 token。</div>
  <table><thead><tr><th>设备</th><th>状态</th><th>最近活跃</th><th>请求数</th><th>在线流</th><th>操作</th></tr></thead><tbody id="devices"></tbody></table>
</section>

<script>
var masked = true;
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function jsq(s) { return String(s).replace(/['\\\\]/g, ''); }
function ago(ts) {
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  return Math.round(s / 3600) + ' 小时前';
}
function renderToken() {
  el('token').textContent = !current.tokenConfigured ? '（未配置）' : (masked ? current.token.slice(0, 6) + '…' + current.token.slice(-4) : current.token);
  el('toggle').textContent = masked ? '显示' : '隐藏';
}
function render() {
  var b = el('banner');
  if (!current.tokenConfigured) {
    b.innerHTML = '<div class="banner warn">尚未配置访问令牌，/m/api 当前拒绝所有连接。点击下方「生成新 token」开始配对。</div>';
  } else {
    b.innerHTML = '<div class="banner hint">网关运行中 · 端口 ' + current.port + ' · 白名单方法 ' + (current.allowSettings ? '含 settings' : '不含 settings') + ' / ' + (current.allowCredentials ? '含 credentials' : '不含 credentials') + '</div>';
  }
  renderToken();
  var q = '';
  if (!current.tokenQrSafe && current.tokenConfigured) {
    q = '<div class="banner warn">token 含有「|」字符，无法生成二维码，请轮换后使用。</div>';
  } else if (current.qrs.length === 0) {
    q = '<div class="muted">未检测到局域网 IPv4 地址，无法生成二维码；请手动输入地址。</div>';
  }
  for (var i = 0; i < current.qrs.length; i++) {
    var c = current.qrs[i];
    q += '<div class="qr-card">' + c.svg + '<div style="margin-top:8px"><code>' + esc(c.ip) + '</code></div><div class="muted" style="font-size:12px;margin-top:2px">' + esc(c.url) + '</div></div>';
  }
  el('qrs').innerHTML = q;
  var d = '';
  if (current.devices.length === 0) {
    d = '<tr><td colspan="6" class="muted">暂无设备连接过</td></tr>';
  }
  for (var j = 0; j < current.devices.length; j++) {
    var v = current.devices[j];
    var did = jsq(v.id);
    var pill = v.blocked ? '<span class="pill blocked">已屏蔽</span>' : (v.online ? '<span class="pill on">在线</span>' : '<span class="pill off">离线</span>');
    var act = v.blocked
      ? '<button onclick="block(\\'' + did + '\\', false)">解除</button>'
      : '<button class="danger" onclick="block(\\'' + did + '\\', true)">屏蔽</button>';
    d += '<tr><td>' + esc(v.name) + '<div class="muted mono" style="font-size:11px">' + esc(v.id) + '</div></td><td>' + pill + '</td><td>' + ago(v.lastSeen) + '</td><td>' + v.requests + '</td><td>' + v.liveStreams + '</td><td>' + act + '</td></tr>';
  }
  el('devices').innerHTML = d;
}
var current = null;
function refresh() {
  fetch('/m/admin/info').then(function (r) { return r.json(); }).then(function (info) { current = info; render(); });
}
el('toggle').onclick = function () { masked = !masked; renderToken(); };
el('rotate').onclick = function () {
  if (!confirm('生成新 token？所有正在使用旧 token 的设备将立即失去访问。')) return;
  fetch('/m/admin/rotate', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (out) {
    if (out.ok) { masked = false; refresh(); } else { alert('轮换失败：' + out.error); }
  });
};
function block(id, blocked) {
  fetch('/m/admin/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, blocked: blocked }) }).then(refresh);
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`
}
