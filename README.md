# DSH Mobile Remote — 手机远程访问本机 Harness

通过手机（外网/局域网）安全地操作**本机电脑上部署的 DeepSeek Harness** GUI：切换会话、新建会话、
切换/新增模型、正常对话与工具调用。手机**只连接本地电脑**，不直接触达模型后端。

> 仓库只含**源码与文档**，不含 APK、密钥、日志等产物（见 `.gitignore`）。APK 需按下方「构建」自行生成。

---

## 架构与数据流

```
手机 App (连接码配对页 → WebView 加载 Harness GUI)
   ⇄ 通道 ⇄       (Tailscale / 公网隧道 / USB+adb reverse)
   ⇄ Mobile Gateway (127.0.0.1:9443, Node 零第三方依赖：认证/限流/审计/移动端注入/反代)
   ⇄ 本机 Harness GUI (127.0.0.1:3080)
   ⇄ AutoDL qwen3.5-9b (模型后端，由 Harness 经 baseURL 调用；手机不触达)
```

- **Gateway**：连接码鉴权、首设备绑定、限流、审计日志、移动端 viewport/CSS 注入、反向代理
  （含 Origin/Referer 改写与 Location 改写）。
- **手机 App**：原生连接码配对页 + WebView 壳加载官方 Harness GUI（SPA，移动端自适应）。

---

## 功能
- 切换/新建会话、切换/新增模型、正常对话与工具调用（复用官方 GUI，零改动）。
- 明确边界：手机只连本机 Harness；模型请求仍由本机 Harness 发往 AutoDL 后端。
- 移动端可用性：注入 viewport 与窄屏样式；WebView 壳提供可改服务器地址的连接页。

---

## 安全模型（无账号密码）
1. **连接码**：Harness 侧仅持一个高熵连接码（`config/pairing.json` 存 scrypt 哈希+盐，仅轮换时明文显示一次，可 `scripts\gen-code.ps1` 轮换）。
2. **首设备绑定**：App 提交 ANDROID_ID+型号 → **首台设备绑定**；之后同一连接码只认该设备，
   其他设备 → `403 bound_other`。
3. **无状态设备会话**：配对成功下发 HMAC 签名的 `dshgw_session` Cookie
   （`HttpOnly; SameSite=Strict; Max-Age=30d`；经 HTTPS 通道时附加 `Secure`），30 天有效、网关重启不失效。
4. **限流**：配对接口每 IP 每分钟 ≤10 次；常规请求限流。取 `socket.remoteAddress`，不信任可伪造的 `X-Forwarded-For`。
5. **移动端加固**（WebView）：禁用远程调试、`MIXED_CONTENT_NEVER_ALLOW`、
   仅放行网关同源导航（外部链接交系统浏览器）、非本机地址强制 HTTPS（防连接码/Cookie 明文泄露）。
6. **网关加固**：静态资源免认证白名单基于「多层解码+规范化」路径，杜绝 `../` 编码穿越；
   会话 Cookie 按 `X-Forwarded-Proto`/socket 加密附加 `Secure`；`/__gw/pair-status` 需认证。
7. **限制**：网关仅监听 `127.0.0.1`；私钥（`dsh-release.keystore`）与会话密钥（`session.key`）不入库。

> 安全加固与审计细节详见 `DESIGN.md`。

---

## 快速开始（本机网关）

```powershell
cd mobile-remote

# 1) 生成/轮换连接码 → 显示 NEW_CODE=XXXX-XXXX（仅本次可见）
powershell -ExecutionPolicy Bypass -File scripts\gen-code.ps1

# 2) 启动网关（前台，Ctrl+C 停止；或注册为开机自启）
powershell -ExecutionPolicy Bypass -File scripts\start-gateway.ps1
# 可选：注册计划任务自启（登录后自动拉起 + 30s 健康看门狗）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

# 3) 健康检查
Invoke-RestMethod http://127.0.0.1:9443/__gw/health
```

**手机连接**（任选一种「手机→电脑」通道）：

| 通道 | 用途 | 手机 App「服务器地址」 | 说明 |
|---|---|---|---|
| USB + adb reverse | 本机联调（最快） | `http://127.0.0.1:9443/` | `adb reverse tcp:9443 tcp:9443` 后，手机本机 127.0.0.1 即宿主网关 |
| Tailscale | 推荐主通道 | `https://<你的电脑名>.ts.net` | 电脑 `tailscale serve --bg http://127.0.0.1:9443`，手机 Tailscale App 同账号 |
| 公网隧道 | 免 Tailscale 外网 | 隧道的 HTTPS 地址 | 如 cloudflared/ngrok 的 `https://...` 地址 |

> 首次连接：App 打开后会自动探测会话；未授权/不可达会停在「输入连接码」页。
> 在「服务器地址」填通道地址、在「连接码」填 `gen-code.ps1` 显示的码，点「连 接」→ 首绑 → 进入 Harness。

---

## 构建 Android APK

需要：JDK 17+、Android SDK（platform android-34 + build-tools 34）。

```powershell
# 重要：签名口令从环境变量读取，仓库不保存
$env:DSH_KEYSTORE_PASS='你的签名口令'
$env:ANDROID_SDK_HOME='<你的 Android SDK 路径>'
powershell -ExecutionPolicy Bypass -File android-app\build-apk.ps1
# 产物：android-app\dist\dsh-remote-v1.0.0.apk（已 .gitignore，不入库）
```

> `android-app\dsh-release.keystore`（签名私钥）不随仓库分发；换机请重新生成并妥善保管口令。

---

## 目录结构

```
mobile-remote/
├─ gateway/                  # Node 零第三方依赖服务
│  ├─ server.js              # 入口：HTTP 监听、免认证端点、认证判定、限流、反代+WS
│  ├─ lib/
│  │  ├─ pairing.js          # 连接码 scrypt 校验 + 首设备绑定（pairing.json）
│  │  ├─ session.js          # 无状态 HMAC 会话 Cookie（session.key）
│  │  ├─ proxy.js            # 反代 + WS upgrade + HTML 注入 + Location 改写
│  │  ├─ store.js            # 内存计数/会话 LRU + 定时清理
│  │  ├─ ratelimit.js        # 滑动窗口限流
│  │  └─ logger.js           # JSONL 日志(access/audit/error/runtime) + 轮转
├─ android-app/              # Android WebView 壳
│  ├─ src/.../MainActivity.java   # 配对页(连接码+服务器地址) + WebView 加载 GUI
│  ├─ res/xml/network_security_config.xml  # 仅本机放行明文，其余禁止
│  ├─ AndroidManifest.xml
│  └─ build-apk.ps1          # 纯手工 aapt2+javac+d8+apksigner 构建
├─ config/gateway.json       # 端口/上游/限额/日志配置
├─ scripts/                  # gen-code / start-gateway / install-autostart / deploy-tailscale / setup / prune-logs
├─ logs/                     # 运行时生成（.gitignore）
├─ DESIGN.md                 # 设计文档
└─ README.md                 # 本文档
```

---

## 安全须知与待办
- `config/pairing.json`、`config/session.key`、`android-app/dsh-release.keystore` 均 `.gitignore`，切勿提交/外泄。
- 连接码只显示一次，轮换后旧码立即失效并解绑。
- **永远不要**绕过 Gateway 直接对公网暴露 3080（Harness GUI 自身无鉴权）。
- 公网隧道会增大暴露面；用完建议停掉或改用 Tailscale 私有通道。
- 设备 ID（ANDROID_ID）为弱凭据，防护依赖高明熵连接码 + 限流；真机首绑后其他设备同码被拒。
- 待办：i18n / iOS·鸿蒙壳同源加固；连接码改由 Harness 插件一键生成；Tailscale 命名隧道以获稳定 HTTPS 地址。
