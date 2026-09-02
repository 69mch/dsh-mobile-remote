# Mobile Remote Gateway — 设计文档 v1

> 让手机在外网安全地操作本机 DeepSeek Harness（"我"所在会话）。
> 范围：基础功能 4 项（切换会话 / 新增会话 / 切换模型 / 新增模型）+ 移动端可用性 + 安全 / 内存 / 垃圾数据 / 日志四大管理。
> 更新：2026-08-28

---

## 1. 总体架构

> 连接目标（澄清 2026-09-02）：手机**只连接本地电脑部署的 Harness**；
> AutoDL 部署的 qwen3.5-9b（llama.cpp）是**模型后端**，由本地 Harness 经其 OpenAI 兼容端点
> （`settings.yaml` 的 baseURL）调用——手机全程不触达 AutoDL。

```
┌──────────────┐   仅你的设备     ┌──────────────────────┐   HTTPS/WS    ┌─────────────────────┐
│  手机        │ ───────────────▶ │ Mobile Gateway        │ ────────────▶ │ 本机 Harness GUI    │
│ 浏览器/PWA   │   Tailscale /    │  (127.0.0.1:9443)     │   反向代理     │  127.0.0.1:3080      │
│ (主屏幕图标) │   其它通道        │  认证/限流/审计/注入   │               │  (我所在会话)        │
└──────────────┘                  └──────────────────────┘               └─────────┬───────────┘
                                                                                   │ 模型请求(baseURL)
                                                                                   ▼
                                                                          ┌─────────────────────┐
                                                                          │ AutoDL qwen3.5-9b   │
                                                                          │ llama.cpp :8443/v1  │
                                                                          └─────────────────────┘
```

### 1.1 为什么不做自研聊天 App
手机要操作的是**现有 Harness 会话与模型**，这些能力（会话 CRUD、模型切换/管理、实时对话、工具调用）官方 Web GUI 已全部实现，且自带 PWA manifest（`display: fullscreen`，可"添加到主屏幕"当 App 用）。
自研一套聊天服务器只能"自弹自唱"，无法接通真实会话。因此本方案 = **零改动的官方 GUI + 安全移动接入层**。

### 1.2 四项基础功能落地方式
| 功能 | 提供方 | 手机操作 |
|---|---|---|
| 切换会话 | GUI 会话列表/侧栏 | 点击会话卡片 |
| 新增会话 | GUI 侧栏 `新建会话` | 点击新建 |
| 切换模型 | GUI `dsh-client-ui-model-selection` | composer 旁模型选择器 |
| 新增模型 | GUI `dsh-client-ui-settings-models` | 设置 → 模型管理 |
> Gateway 对 GUI HTML 注入 `viewport` 与移动端 CSS 钩子，使桌面布局在手机可读可点。

### 1.3 通道说明
手机只需触达**本机 Harness GUI**，通道只在「手机 ⇄ 本机」这一段，与 AutoDL 模型无关：

| 通道 | 角色 | 路径 | 访问地址形态 |
|---|---|---|---|
| **Tailscale** | 主 | 手机 ⇄ tailnet ⇄ 本机 `tailscale serve` ⇄ Gateway | `https://<机器名>.ts.net`（Tailscale 自动签发合法 TLS） |
| **备选** | 兜底 | 手机 ⇄ 任意可达本机的通道 ⇄ Gateway | 视所选通道而定（需保证手机可触达本机 9443） |

> 早期草稿中的 "AutoDL SSH 反向隧道" 备通道**已废弃**：那会把 AutoDL 变成网络中继，违背
> "AutoDL 只是模型后端"的边界，且 AutoDL 的 8443 端口是模型服务专用。备选通道若将来需要，
> 建议用可自愈的公网通道（如 frp/cloudflared）直连本机 9443，与 AutoDL 完全解耦。

---

## 2. 安全设计（S）

### 2.1 威胁模型
| 威胁 | 缓解 |
|---|---|
| 公网扫描/爆破连接码 | 配对限流（每 IP 每分钟 ≤10 次）；码为 8 位高熵随机且只显示一次 |
| 未授权设备访问（Tailscale 通道） | tailnet 设备隔离（默认仅你的账号设备） |
| 中间人/窃听 | 全链路 TLS（ts.net 自动证书） |
| 设备冒充/多设备共用 | **首设备绑定**：配对记录 ANDROID_ID+型号；他设备同码 → 403 bound_other |
| 会话劫持 | HttpOnly + SameSite=Strict Cookie；设备会话 30 天 + 内存 LRU |
| Gateway 被攻破后横向 | Gateway 以普通用户运行、最小依赖（零 npm 第三方包）、仅监听 127.0.0.1 |

### 2.2 认证链（Gateway，连接码 + 设备绑定，v1.1）
1. **第一道（通道级）**：Tailscale tailnet 身份（主通道）。
2. **第二道（连接码）**：Harness 侧持**唯一连接码**（`config/pairing.json` 存 scrypt 哈希+盐；
   运行 `scripts\gen-code.ps1` 轮换 → 旧码作废并解除绑定）。
3. **第三道（首设备绑定）**：App 提交 `deviceId`(ANDROID_ID)+型号 → 首次配对即绑定该设备；
   之后**同一连接码只认该设备**，其他设备 → 403。
4. **第四道（会话）**：配对成功下发设备会话 Cookie（30 天），GUI 无鉴权但全部请求先过 Gateway。

### 2.3 安全细则
- 连接码不在 pairing.json 明文存储（scrypt+盐）；仅轮换时打印一次。
- 设备会话 Cookie：`HttpOnly; SameSite=Strict; Max-Age=30d`；服务端 sessionId 存内存 Map（LRU+定期清理）。
- 配对接口限流：每 IP 每分钟 ≤10 次；反代仅允许转发到配置 `upstream`（127.0.0.1:3080）防 SSRF。
- 反代改写 Origin/Referer 为 upstream 源，满足 Harness host RPC 的 CSRF 同源校验（否则 403）。
- 所有随机值用 `crypto.randomBytes`/`randomInt`。
- Android 10+ 无法读 IMEI（系统权限限制）→ 设备唯一标识 = ANDROID_ID + Build.MANUFACTURER/MODEL；<Android10 附 IMEI。
- Tailscale 通道全链路 WireGuard + ts.net 自动 TLS，为唯一推荐公网通道。

---

## 3. 内存管理（M）

| 关注点 | 策略 |
|---|---|
| 反代缓冲 | 全程流式转发（`pipe`），不整包缓存大响应；仅注入 HTML 时对 `text/html` 且 < 2MB 的响应做流内改写 |
| 会话存储 | 登录会话用 Map + 最大条目数（默认 200），LRU 淘汰；过期惰性清除 + 定时（10min）清除 |
| 限流计数 | 滑动窗口 Map，定时（5min）清理过期 key，防无限增长 |
| 审计日志 | 同步追加写文件 + 每 5s 或 512KB flush；不缓存无限内存 |
| 连接 | 空闲 socket 超时（60s）、请求头/体大小上限（10MB）、最大并发（默认 64，超出返回 503） |
| 流控 | 背压用 `pipe` 天然处理；WebSocket 转发不缓冲 |

---

## 4. 垃圾数据管理（G）

| 类型 | 策略 |
|---|---|
| 日志轮转 | 日志按天滚动 + 大小滚动（单文件 ≤5MB），保留最近 7 天自动删除 |
| 过期会话 | 定时清内存中过期 sessionId（见 §3） |
| 上传/临时文件 | 若启用文件转发，临时落盘目录每次启动清空 + 每日清理 >1h 文件 |
| 崩溃残留 | 启动时清理 `runtime/*.pid`、`runtime/*.sock` |
| 内存垃圾 | 见 §3 定时清理；Node 自身 GC 不干预 |
| 手机侧 PWA | Service Worker 缓存仅 `start_url` 与静态壳，不缓存会话数据 |

---

## 5. 日志管理（L）

统一 JSONL 结构化日志，分四类，全部走同一写入器（并发安全、防截断、轮转）：

| 类别 | 文件 | 内容 |
|---|---|---|
| 访问 | `logs/access-YYYYMMDD.jsonl` | ts、clientIp、method、path、status、耗时、UA |
| 审计 | `logs/audit-YYYYMMDD.jsonl` | 登录成功/失败、登出、锁 IP、2FA 结果、配置变更（含来源） |
| 错误 | `logs/error-YYYYMMDD.jsonl` | 反代/上游错误、TLS 错误、未捕获异常（含 stack 摘要） |
| 运行 | `logs/runtime.log` | 启动/停止/轮转/隧道状态/心跳 |

- **不落盘**：口令、TOTP 种子、Cookie、消息正文。
- 审计日志单独追加不可静默关闭；写失败时 Gateway 拒绝登录（fail-closed）。
- 保留策略统一在配置 `logs.retainDays=7`；提供 `scripts/prune-logs.ps1` 手动清理。

---

## 6. 目录结构

```
mobile-remote/
├─ gateway/                  # Node 零第三方依赖服务
│  ├─ server.js              # 入口：HTTP(S) 双监听、中间件装配
│  ├─ lib/
│  │  ├─ logger.js           # JSONL 日志写入 + 轮转
│  │  ├─ auth.js             # 登录/会话/Cookie/scrypt
│  │  ├─ totp.js             # RFC6238（内置 crypto）
│  │  ├─ ratelimit.js        # 滑动窗口限流
│  │  ├─ proxy.js            # 反代 + WS upgrade + HTML 注入
│  │  └─ store.js            # 内存会话/计数存储 + 清理
│  └─ certs/                 # 自签证书（setup 生成，gitignore）
├─ config/
│  ├─ gateway.json           # 端口/上游/限额/保留期等
│  └─ secrets.json           # 口令哈希/盐/TOTP（仅本用户可读）
├─ scripts/
│  ├─ setup.ps1              # 一键初始化 + 服务注册
│  ├─ start-gateway.ps1 / stop-gateway.ps1
│  ├─ prune-logs.ps1
│  └─ deploy-tailscale.ps1   # 主通道
├─ deploy/
│  ├─ autodl-tunnel.ps1      # 备通道 SSH -R + 看门狗
│  └─ watchdog.ps1
├─ logs/                     # 运行时生成（gitignore）
└─ DESIGN.md / README.md
```

---

## 7. 实施顺序（本仓库）
1. Gateway 服务（server/lib）✅ 本阶段
2. setup.ps1 初始化（密钥/证书/服务）
3. Tailscale 主通道脚本
4. （可选）备选公网通道脚本（与 AutoDL 解耦）
5. README 操作手册（手机侧步骤）
6. 端到端验证与加固
