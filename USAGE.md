# dsh-mobile-gateway 使用说明

> 配套手机 App（DeepSeek Harness Mobile）完整使用指南。
> 服务器端只需要官方版 dsh + 本插件，**不需要下载源码、不需要改代码、不需要编译**。

[English](USAGE.en.md) | 中文

---

## 目录

1. [整体架构](#整体架构)
2. [准备条件](#准备条件)
3. [服务器端：三步安装](#服务器端三步安装)
4. [管理页：token、二维码与设备管理](#管理页token二维码与设备管理)
5. [手机端：安装与连接](#手机端安装与连接)
6. [App 功能一览](#app-功能一览)
7. [配置参考](#配置参考)
8. [安全模型](#安全模型)
9. [故障排查](#故障排查)
10. [常见问题](#常见问题)

---

## 整体架构

```
┌────────────────────────── 你的电脑（同一 Wi-Fi / 局域网）──────────────────────────┐
│                                                                                   │
│   官方 dsh web（npm 安装，无任何改动）                                               │
│   ├─ /api          官方接口 ── 仅本机(127.0.0.1)可访问，本机浏览器照常使用            │
│   └─ /m/api        本插件挂载 ── 局域网可访问，必须携带 Bearer token                  │
│         ├─ 全部会话/工作区/模型 RPC（白名单制）                                       │
│         ├─ /m/api/respond          审批、提问应答                                    │
│         └─ /m/api/events.mux|.host 两条 WebSocket 实时事件流                          │
│                              ▲                                                     │
└──────────────────────────────┼─────────────────────────────────────────────────────┘
                               │ Wi-Fi（局域网明文 HTTP + token 认证）
                        ┌──────┴──────┐
                        │  手机 App   │  地址: http://<电脑IP>:<端口>
                        │ (Flutter)   │  token: 与插件配置一致
                        └─────────────┘
```

**一句话**：插件把 dsh web 的网卡打开并对官方 `/api` 关门，只留一条带 token 验票的 `/m/api` 通道给手机 App。

## 准备条件

**电脑（服务器端）**

- 已安装官方 [DeepSeek Harness](https://npmjs.com/package/@deepseek-ai/dsh)（`npm install -g @deepseek-ai/dsh`，当前验证版本 `0.1.2-rc.1`）
- Node.js `^22.19` 或 `>=24`
- 已配置好可用的模型（App 内也可查看/切换，但 dsh 本身需有一个可用 provider）

**手机**

- Android 8.0+（APK 直接安装）；或自行用源码构建（支持 Android + Windows）
- 与电脑在**同一局域网**（连同一个 Wi-Fi / 路由器）

## 服务器端：三步安装

### 第 1 步：安装插件

```powershell
dsh plugin --profile web add github:elskly-cmyk/dsh-mobile-gateway
#   首次安装 pnpm 会询问是否允许构建本包（allowBuilds），按 dsh 的提示放行即可
dsh plugin --profile web add link:<本插件仓库路径>       # 开发调试用本地路径
```

### 第 2 步：配置 token

> **可以跳过这一步**——装好插件启动后，打开本机浏览器
> `http://127.0.0.1:3080/m/`，点「生成新 token」一键完成（见
> [管理页](#管理页token二维码与设备管理)）。以下为手动方式。

生成一个长随机串（任选其一）：

```powershell
# PowerShell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })

# Node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

写入配置。**两种途径任选**：

<details>
<summary><b>途径 A：编辑配置文件</b>（推荐，一次配好）</summary>

编辑 `~\.dsh\profiles\web\cordis.patch.yml`（Windows）或 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: mobile-gateway
  config:
    token: 把生成的随机串粘到这里
```

改这个文件需要重启 `dsh web` 生效。

</details>

<details>
<summary><b>途径 B：Web 设置卡</b>（热生效，不用重启）</summary>

本机浏览器打开 `http://127.0.0.1:3080` → 设置 → 插件配置 → mobile-gateway → 填入 token。
保存即生效，无需重启。

</details>

> **token 未配置或为空时，插件会拒绝启动并明确报错**——这是故意的（fail-closed），不会静默暴露。

### 第 3 步：启动

```powershell
dsh web
```

不需要任何命令行参数。插件会自动：

- 绑定所有网卡（手机可达）
- 启动行打印局域网地址，例如：
  ```
  dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)
  ```
- 把官方 `/api` 收窄为仅本机访问（本机浏览器不受影响，局域网直连 `/api` 一律 403）

**首次启动防火墙**：Windows 会弹"允许 Node.js 入站连接"，勾选**专用网络**（如果你的
Wi-Fi 被归为公用网络，公用也要勾）。漏点了用这条命令补：

```powershell
New-NetFirewallRule -DisplayName "dsh web" -Direction Inbound `
  -Program "C:\Program Files\nodejs\node.exe" -Action Allow
```

Linux 则类似 `sudo ufw allow 3080`。

---

## 管理页：token、二维码与设备管理

插件自带一个**仅限本机访问**的管理页。两种进入方式：

- **侧边栏入口**（v0.3.0+）：官方 Web GUI 侧边栏底部、设置按钮旁的**手机图标**，点击后管理页以**当前页弹窗**展开（Esc/关闭按钮/点遮罩收起；弹窗右上角「新标签页」可切换为完整页面）
- **直接输 URL**：电脑浏览器打开 `http://127.0.0.1:3080/m/`

（端口以你的启动输出为准；局域网地址打开会得到 403——token 是配对密钥，
不在本机以外的任何屏幕上显示。入口图标只在本机打开的页面上出现。）

不想显示入口图标时：设置 → 插件配置 → mobile-gateway → 关闭「显示侧边栏入口」
（即 `uiEntry: false`，热生效；`/m/` URL 本身永远可用）。

页面提供四块能力：

| 区块 | 说明 |
| --- | --- |
| **访问令牌** | 查看当前 token（默认打码，点击显示）；「生成新 token」一键轮换——**热生效**：旧 token 的下一次请求立即 401，无需重启，且重启后依然保留（写入 `~/.dsh/settings.yaml`） |
| **扫码配对** | 每个局域网 IPv4 地址一张二维码（多网卡机器全部列出）。手机 App 连接页点「扫码配对」对准任意一张，地址与令牌自动填入 |
| **已连接设备** | 每台连接过的设备一行：名称（如 `Android 14`）、在线状态（含实时流计数）、最近活跃、请求数；可单台「屏蔽 / 解除」 |
| **状态横幅** | 未配置 token 时红条警示并引导生成；正常运行时显示端口与白名单开关状态 |

**设备屏蔽语义**：屏蔽在下一次请求生效、重启后清除（临时踢出）；要永久
踢出所有设备，用「生成新 token」轮换。

**token 的三处来源，优先级从高到低**：管理页/Web 设置卡轮换结果（user 层，
`~/.dsh/settings.yaml`）→ profile patch 里的 `token:`（base 层）→ 空（未配对，
`/m/api` 拒绝一切连接，管理页红条提示）。未配置 token 插件**不会启动失败**——
管理页照常可用，配对从这里开始。

---

## 手机端：安装与连接

### 安装 App

- **直接安装**：从 GitHub Releases 下载最新 `dsh_mobile_app-v*.apk`（**需 v1.0.36+**：
  此版本起默认走插件的 `/m/api` 通道并支持扫码配对；旧版 APK 走 `/api`，无法配合本插件）
- **源码构建**：克隆 [App 仓库](https://github.com/your-name/dsh-mobile-app)，然后：

  ```powershell
  flutter build apk --release     # 通用
  # 或使用仓库自带脚本（本机工具链版）
  powershell -ExecutionPolicy Bypass -File build_apk.ps1
  ```

### 连接

**方式一：扫码（推荐）**

1. 手机连上与电脑相同的 Wi-Fi
2. 电脑浏览器打开 `http://127.0.0.1:3080/m/`，页面已生成二维码
3. 手机 App 连接页点「扫码配对」（首次会请求相机权限），对准二维码
4. 地址与令牌自动填入，点「连接」即可

**方式二：手动输入**

1. 打开 App，连接页填写：
   - **服务器地址**：启动行里 `LAN:` 后面的地址，如 `http://192.168.1.5:3080`
   - **访问令牌**：管理页或配置文件里的 token
2. 点连接。App 会调用 `host.describe` 验证地址和 token，成功后进入主界面

> **地址中不能有空格**——空格会被 URL 编码成 `%20`，触发 IPv6 zone-id 误判，报
> "not a valid link-local address"。IP 和端口之间只用冒号。

连接成功后，地址和 token 会安全存储在手机上，下次打开 App 自动回填。

---

## App 功能一览

| 功能 | 说明 |
| --- | --- |
| **会话抽屉** | 按工作区分组（组级折叠、有运行任务的组自动展开）；分组头「新建会话」自动归入该工作区 |
| **聊天** | 流式实时输出；深度思考折叠展示；消息按 Markdown 渲染；支持发送图片附件 |
| **工具调用** | 工具树 + 底部抽屉查看每次调用的参数与结果 |
| **审批卡** | 危险操作弹出批准/拒绝卡，手机上一键应答（走 `/m/api/respond`） |
| **提问面板** | Agent 向你提问时底部弹层作答 |
| **模型切换** | provider 分组目录 + 每模型思考强度（effort），与桌面端同一会话设置实时同步 |
| **权限预设** | 会话级权限切换（只读 / 工作区可写 / 完全权限） |
| **Goal / Plan / Todo** | 目标、计划、任务清单实时投影面板 |
| **队列与打断** | 消息排队（queue/steer）、取消正在运行的任务 |
| **后台任务** | 每会话后台 job 列表与状态 |
| **子代理** | 子会话列表、追问、打断 |
| **搜索** | 全部会话全文搜索（`session.search`） |
| **会话导出** | 下载会话日志（`session.export`） |
| **设置页** | 通用/模型/Agent 预设/插件 只读详情（改配置请回桌面端或用本插件放行的写接口） |
| **外观** | 深色 / 浅色 / 跟随系统，选择持久化 |
| **断线重连** | 双 WebSocket 流掉线自动指数退避重连，状态条实时显示 |

## 配置参考

全部配置项（默认值就绪，只必须填 `token`）：

```yaml
- id: mobile-gateway
  config:
    token: <必填，长随机串>
    allowSettings: true          # 放行 settings.* 读写（App 设置页要用）
    allowCredentials: true       # 放行 credentials.* 密钥管理
    uiEntry: true                # 桌面 Web GUI 侧边栏显示手机入口图标
    extraMethods: []             # 追加放行方法，如 ['subagent.history']
    maxRequestBodyBytes: 750000000
```

**默认白名单**（token 验证后可用）：

| 域 | 方法 |
| --- | --- |
| 会话 | `session.list/create/history/prompt/rename/updateQueue/fork/cancel/attachment/models/selectModel/search/export` |
| 工作区 | `workspace.list/create/rename/delete/archiveSession` |
| 目录 | `host.describe/listDirectory/createDirectory` |
| 子代理 | `subagent.list/prompt/interrupt` |
| 目标 | `goal.create/edit/complete/clear/pause/resume` |
| 技能 | `skill.list` |
| 命令 | `commands/list`、`commands/execute`（会话级斜杠命令） |
| 模型目录 | `llm.models/providers` |
| 设置（可关） | `settings.describe/update/replace/mutate` |
| 凭据（可关） | `credentials.describe/set/unset` |

**始终拒绝**：`host.pickDirectory/openPath`（驱动电脑原生对话框）、`llm.discoverModels`、
`agentPreset.read/copy/...`（预设管理）。需要扩展时用 `extraMethods` 显式追加。

## 安全模型

- **token 是唯一的钥匙**：恒定时间比对，无法通过时间侧信道探测。持 token 者 = 拥有白名单内
  完整 agent 能力（包括在你电脑上执行命令的会话）。请用足够长的随机串（≥32 字节）。
- **官方 `/api` 被本插件收窄为仅本机**：绑 `0.0.0.0` 后 SDK 默认会自动信任局域网 IP——
  插件显式关闭了这个行为（`trustedHosts: []`），局域网内任何设备直连 `/api` 一律 403。
  本机浏览器不受影响。
- **`--trusted-host` 在本插件下无效**：插件覆盖了对应的配置表达式。**永远不要**为了任何
  目的去改回它——那会把官方 `/api` 整个裸露给局域网并绕过 token。
- **边界是局域网**：本插件不含公网隧道。需要外网访问请自行架设带认证的通道
  （Cloudflare named tunnel、Tailscale 等），并确认它透传 WebSocket。
- **撤销访问**：改 token（Web 设置卡热生效，所有手机立即失效）或
  `dsh plugin --profile web remove dsh-mobile-gateway` 后重启。
- **明文 HTTP**：局域网内传输不加密。家用 Wi-Fi 风险可控；公司/公共网络请慎用或加隧道。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| App 连接报 401 | token 不一致。管理页（/m/）或设置卡轮换后要重新扫码/更新 App 里的令牌 |
| App 连接报 403 | 方法不在白名单（连接探测 `host.describe` 被关）、**设备被屏蔽**（去 /m/ 解除）或官方 `/api` 被正确关闭——确认 App 是 v1.0.36+（走 `/m/api`），插件是最新版 |
| 管理页 /m/ 打开是 403 | 用了局域网地址打开。必须用 `http://127.0.0.1:<端口>/m/` 在**电脑本机**浏览器打开 |
| 扫码后提示"二维码内容不是配对信息" | 扫的不是管理页的二维码，或 token 含 `\|` 字符（管理页会警示，轮换即可） |
| 连接超时 / 无响应 | ① 不在同一 Wi-Fi；② 防火墙拦了 Node 入站（见上文 netsh 命令）；③ 地址填了 `127.0.0.1`——手机上必须填电脑的局域网 IP |
| "无效的服务器地址" | 缺 `http://` 前缀或 host 为空；地址里不能有空格 |
| 设置页打不开 / 报错 | `allowSettings` 或 `allowCredentials` 被关了；或 App 版本低于 v1.0.36（旧版走 `/api`，特权方法仅本机） |
| 启动报 "apiProxy service lacks the required seams" | dsh 版本与插件不兼容（见下条） |
| 升级 dsh 后插件异常 | 插件启动自检会拒绝不兼容版本。把 dsh 固定在验证过的版本，或等插件更新 |
| 发图失败 413 | 请求体超上限；检查 `maxRequestBodyBytes` 与 attachment 限额是否被手动改小 |
| 手机收到消息延迟 | WebSocket 流断开重连中；状态条会显示，稳定 Wi-Fi 下自动恢复 |

## 常见问题

**多台手机能同时连吗？**
能。token 是共享的——所有持有同一 token 的设备能力相同。临时踢某一台用管理页
的「屏蔽」；踢全部就轮换 token。

**轮换 token 后要重启吗？**
不用。轮换热生效：旧 token 的下一个请求立即 401，新 token 立即可用；已打开的
WebSocket 流在下次重连时被拒。结果持久化在 `~/.dsh/settings.yaml`，重启不丢。

**换了 Wi-Fi / 电脑 IP 变了怎么办？**
管理页的二维码按当前所有 IPv4 地址生成，刷新 `/m/` 页重新扫即可；App 里也可以
手动改服务器地址（token 不变）。

**电脑上的浏览器还能正常用吗？**
能。本机 `http://127.0.0.1:3080` 的官方 Web GUI 完全不受影响。但**局域网内其他电脑的
浏览器**打开不了 Web GUI（`/api` 已仅本机）——这是刻意的安全姿态；其他电脑请也用手机 App
（或 Android/Windows 版 App）。

**和自编译 fork 的方案（`DSH_HOST_AUTH_TOKEN` + `--host 0.0.0.0`）什么关系？**
本插件是它的"零编译替代"：官方 npm dsh + 一条安装命令即可，不再需要维护 fork。
Dart SDK 的 `DshApiClient` 保留了 `apiPrefix` 参数（默认 `/m/api`），传 `/api`
即可连回旧 fork 后端。

**token 在哪里改最方便？**
Web 设置卡（热生效）：`http://127.0.0.1:3080` → 设置 → 插件配置 → mobile-gateway。

**已验证环境**
官方 `@deepseek-ai/dsh@0.1.1-rc.2`（npm latest）· Node 24 · Windows /
Android 真机 · 全链路实测（认证、会话、流式、审批、WS 事件流、日志导出）。
