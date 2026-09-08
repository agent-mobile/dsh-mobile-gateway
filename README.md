# dsh-mobile-gateway

[English](README.en.md) | 中文

> DeepSeek Harness（DSH）官方版的局域网访问插件：装一个插件，手机 App 直接连。
> 不改 dsh 源码、不需要重新下载编译——`dsh plugin` 一条命令安装，`dsh web` 裸启动即可。

**完整使用说明（配手机 App）见 [USAGE.md](USAGE.md)。**

## 它解决什么问题

官方 `dsh web` 出于安全默认只监听 `127.0.0.1`，且官方 CLI 显式拒绝 `--host 0.0.0.0`。
手机（或局域网内任何设备）因此连不上主机。本插件以官方扩展点实现远程访问：

| 动作 | 机制 |
| --- | --- |
| 服务器监听所有网卡 | 插件的 `cordis.patch.yml` 覆盖 `webserver` 行配置为 `host: 0.0.0.0`（`--port` 仍可用；卸载插件即恢复仅本机） |
| 官方 `/api` 收窄为仅本机 | 绑 `0.0.0.0` 时 SDK 会自动信任局域网 IP（相当于无认证暴露）——插件把 `trustedHosts` 置空关闭该行为；本机浏览器不受影响，`--trusted-host` 在本插件下失效 |
| 手机调用全部 RPC | 在官方 `/api` 旁挂一条 token 门控的 `/m/api` 前缀路由，验票后进程内转发给官方 `apiProxy`（`toFetchHandler`），不碰官方围栏 |
| 实时消息推送 | `/m/api/events.mux`、`/m/api/events.host` 两条 WebSocket 下行流，帧格式与官方完全一致，只改路径前缀 |
| 审批 / 提问应答 | `/m/api/respond` 直通官方 respond 通道 |
| 大图发送 | 顺带放宽 attachment 图片限额与请求体上限（500 MB 消息图片可用） |
| **管理页 `/m/`** | 仅限本机：一键生成/轮换 token（settings 热生效、持久化）、按网卡生成配对二维码、设备列表与单台屏蔽 |
| **侧边栏入口** | 官方 Web GUI 侧边栏底部（设置旁）的 手机 图标，**当前页弹窗**打开管理页（可一键转新标签页；v0.3.3+，`uiEntry` 可关） |
| **扫码配对** | 二维码编码 `服务器\|令牌`，配套 App（v1.0.36+）扫码自动填入 |

## 快速开始

```sh
# 1. 安装官方 dsh（已装可跳过）
npm install -g @deepseek-ai/dsh

# 2. 安装本插件（从 GitHub，一条命令）
dsh plugin --profile web add github:elskly-cmyk/dsh-mobile-gateway
#   首次安装 pnpm 会询问是否允许构建本包（allowBuilds），按 dsh 的提示放行即可；
#   开发调试:  dsh plugin --profile web add link:<本仓库路径>

# 3. 配置 token（见下），然后启动——不用任何 flag
dsh web
#   启动行会打印 LAN 地址，例如:
#   dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)

# 4. 手机 App（同一 Wi-Fi）连接 http://<电脑IP>:3080 + token
```

> **首次启动防火墙**：Windows 会弹"允许 Node.js 入站连接"，勾选专用网络即可；
> Linux 需要 `sudo ufw allow <端口>` 之类放行。

## 配置

token 必填，其余有默认值。两种配置途径：

**途径一：profile patch**（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: mobile-gateway
  config:
    token: 换成一个长随机串
    allowSettings: true        # 设置面（settings.*），默认 true
    allowCredentials: true     # 凭据面（credentials.*），默认 true
    extraMethods: []           # 追加放行的方法名，如 ['subagent.history']
    maxRequestBodyBytes: 750000000
```

**途径二：Web GUI 设置卡**（设置 → 插件配置 → mobile-gateway），改完热生效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `token` | （必填） | App 侧以 `Authorization: Bearer <token>` 呈现；留空插件拒绝启动 |
| `allowSettings` | `true` | 放行 `settings.describe/update/replace/mutate` |
| `allowCredentials` | `true` | 放行 `credentials.describe/set/unset` |
| `extraMethods` | `[]` | 白名单之外追加放行的方法 |
| `maxRequestBodyBytes` | `750000000` | `/m/api` 单请求体上限（须与 connection 行同步调大） |

## 方法白名单

默认放行（token 验证后）：会话（`session.*` 含 `export` 下载）、工作区、`host.listDirectory/createDirectory`、subagent、goal、`skill.list`、`commands/list/execute`（会话级斜杠命令，范围不超 `session.prompt`）、`llm.models/providers`，加上可选的 settings / credentials 面。

**始终拒绝**：驱动宿主机原生对话框的 `host.pickDirectory/openPath`、探针型 `llm.discoverModels`、agent 预设管理（`agentPreset.read/copy/...`）——手机端无意义或有侦察价值，不给就不给。

## App 侧需要什么

配套 App（dsh_mobile_app / dsh_dart_sdk）**v1.0.35+ 已默认走 `/m/api`**，直接可用：

| 官方 fork 直连（`apiPrefix: '/api'`） | 本插件（默认） |
| --- | --- |
| `POST /api/<method>` | `POST /m/api/<method>` |
| `POST /api/respond` | `POST /m/api/respond` |
| `ws://…/api/events.mux` | `ws://…/m/api/events.mux` |
| `ws://…/api/events.host` | `ws://…/m/api/events.host` |

token、信封格式、帧格式、rpcId 关联全部不变。`DshApiClient` 保留 `apiPrefix`
参数（默认 `/m/api`），传 `/api` 可连回自编译 fork 的后端。

## 安全须知

- **token 就是钥匙**：生成足够长的随机串（如 `openssl rand -hex 32`）。持有 token 的设备拥有白名单内的完整 agent 能力（含在你电脑上执行命令的会话）。
- **边界是局域网**：本插件不提供公网隧道。需要外网访问请自行加 Cloudflare named tunnel / Tailscale 等带认证的通道，且确保该通道透传 WebSocket。
- **不要用 `--trusted-host`**：那会把官方 `/api` 直接暴露给局域网并绕过本插件的白名单；本插件的路线完全不依赖它。
- **停用**：`dsh plugin --profile web remove dsh-mobile-gateway` 并重启，服务器恢复仅本机监听。

## 兼容性

- 已验证：`@deepseek-ai/dsh` **0.1.2-rc.1**（`dsh.engines` 要求 `>=0.1.2-rc.1`），Node `^22.19 || >=24`。
- 插件启动时自检官方接缝（`apiProxy.respond/events.*`、`toFetchHandler`）；dsh 升级后接缝变动会**启动即报错**，不会静默半瘫。
- 依赖的接缝都是官方 npm 包的公开导出（`dsh-host-webserver` 路由注册、`dsh-host-apiproxy` 服务与 fetch carrier）。

## 开发

```sh
pnpm install
pnpm test          # 单测 + 真实 WebServer/toFetchHandler 集成测试
pnpm run typecheck
pnpm run build     # 产物 lib/index.js（官方包全部外部化）
node scripts/e2e-ws-probe.cjs <port> <token>   # 对运行中的 dsh web 探测 WS 通道
```

## 已验证行为（真实官方 dsh + 本插件）

- 裸 `dsh web` 绑定 `0.0.0.0`，URL 行自动打印 LAN 地址
- **官方 `/api` 从局域网直连一律 403**（fence 已收窄）；本机 `127.0.0.1` 浏览器照常 200
- `/m/api`：无 token / 错 token → `401`；白名单外方法（如 `host.openPath`）→ `403`；被屏蔽设备 → `403`
- `host.describe`（App 连接探测）、`llm.providers`、`settings.describe` → `200` + 真实数据
- `/m/api/respond` 直通官方通道（未知 rpcId 正确返回 `{"accepted":false,"reason":"not-pending"}`）
- WS：无 token 握手被 `403` 拒绝；带 token 握手成功，帧格式与官方下行一致
- **管理页 `/m/`**：本机 200 / 局域网 Host 403；轮换 token 后旧 token 立即 401、新 token 立即 200（热生效），重启后依然有效；设备按 `x-dsh-device` 头（缺省按 IP）追踪，屏蔽/解除即时生效
- Dart SDK 真机链路（`dart run tool/smoke.dart http://127.0.0.1:3080 <token>`）：
  认证、`session.list/create/prompt/history`、mux 事件流全部通过

## 许可证

[MIT](LICENSE)
