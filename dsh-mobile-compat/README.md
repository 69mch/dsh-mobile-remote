# dsh-mobile-compat — 原生 DSH 客户端插件（移动端皮肤开关）

把 mobile-remote 的移动端皮肤做成 **DSH 原生客户端插件**，在 web profile 里注入并可用开关启停
（替代/补充外部网关注入）。结构对齐同仓 MIT 示例 `dsh-remote-mobile` / `dsh-webgate`。

## 文件
```
dsh-mobile-compat/
├─ package.json        # dsh.bundle.patch=cordis.patch.yml; dsh.client(platform:web, inject: client-runtime); exports["./client"]
├─ cordis.patch.yml    # 向 web profile 追加本插件行（dsh bundle 机制自动合并）
├─ src/client.js       # 客户端源码（ESM）：窄屏注入 MOBILE_CSS，localStorage 开关，ctx.effect 清理
└─ README.md           # 本文件
```

## 待完成（需要在你可验证的 DSH web 环境内做，本会话客户端平台不可达）
1. **粘贴全量皮肤**：把 `gateway/skin/mobile.css` 全文粘进 `src/client.js` 的 `MOBILE_CSS`。
2. **确认客户端样式服务名**：在 DSH web 运行态查询客户端 `Service` 的样式服务（示例用 `ctx.get('styles').insert(css)`，返回 disposer；如实际服务名不同以查询为准）。
3. **构建客户端 bundle**：参照 `dsh-remote-mobile`/`dsh-webgate` 的 `scripts/build-client.js`
   （esbuild 把 ESM 包成 `window.__ModuleLoader__.load({id, factory})`）生成 `lib/client.js`。
4. **安装并重启**：
   ```bash
   cd dsh-mobile-compat && npm i && npm run build
   dsh plugin --profile web add link:<本目录绝对路径>   # 或 npm 发布后 add 包名
   dsh web --restart                                    # 重启生效
   ```
5. **验证**：手机打开 GUI → 皮肤生效；窄屏右下角（或设置项）出现"移动适配 开/关"。

## 注意
- 本插件是**脚手架**：结构/字段已对齐真实 DSH 插件规范，但第 2/3 步必须在有客户端响应页的
  DSH 环境里完成并验证（本会话无法 Inspect 客户端、无法重启 DSH）。
- 皮肤 CSS 亦可继续由外部网关注入；本插件只负责"是否开启移动兼容"的原生开关。
