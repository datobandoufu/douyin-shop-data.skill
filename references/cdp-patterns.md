# CDP 稳健抓取模式与坑点（抖店后台）

本技能所有脚本通过 Chrome DevTools Protocol (CDP) 在已开启远程调试的 Chrome 上驱动抖店后台。以下为经实战验证的稳健模式与坑点。

## 1. 连接拓扑
- 调试 Chrome 必须带 `--remote-debugging-port=9222` 且使用**非默认** `--user-data-dir`（新版 Chrome 禁止在默认资料目录开远程调试）。默认用 `C:/tmp/chrome-debug`（一份带登录态的调试资料副本，可用 `DD_CHROME_USER_DATA` 覆盖）。
- 取目标页 WS：`GET /json/list` → 找 `type==='page' && url.includes('fxg.jinritemai.com')` → 用其 `webSocketDebuggerUrl`。
- 取浏览器级 WS（关标签等）：`GET /json/version` → `webSocketDebuggerUrl`。
- 关闭非 fxg 标签：`Target.closeTarget{targetId}` 经浏览器级 WS 发送。

## 2. 稳健驱动封装（scripts 内每个 .cjs 各自实现了一份，参数为参考）
- `httpGet(path)`：包装 `/json/list`、`/json/version`，`setTimeout(2000)` 防挂。
- `connectToTarget(wsUrl)`：单 WS → `Page.enable` + `Runtime.enable` → 返回 `{ws, send, close}`。内部用自增 `id` + `pending` Map 配对响应，`send` 带 `timeoutMs` 超时。
- `evalJS(send, expr, retries=3~5)`：所有 `Runtime.evaluate` 走重试；抖店页面有长任务，**复杂 evaluate（含 querySelectorAll/getBoundingClientRect/返回对象）极易间歇超时**，轻量 `!!document.querySelector(...)` / `document.body.innerText` 通常能插空成功。
- `clickAt(send,x,y)`：`Input.dispatchMouseEvent` 发 `mousePressed`+`mouseReleased`（真实鼠标，非 JS click）。
- `closePopups(conn)`：`2 轮 × Escape`（随机停顿防机械连发）+ 轻量 button/modal 扫描；**勿用激进版**（曾 `querySelectorAll('*')` 全页扫描触发 Chrome 崩溃）。

## 3. 截图与 DOM 抓取
- 截图用 `Page.captureScreenshot`（走 compositor，对 JS 主线程死锁免疫）—— 调试时验证页面状态首选。
- DOM 抓取加位置过滤 `y<120 && width>400` 排除悬浮件（如 AI 助手浮窗、通知气泡）。
- **不要用** `Input.enable`：非标准 CDP 方法，per-target WS 上报错，移除即可。
- `DOM.getDocument` 用 `depth:-1`（全树）会序列化超时，改用 `depth:1` + `DOM.querySelectorAll` 定位节点 → `DOM.getBoxModel` 取坐标 → `Input.dispatchMouseEvent` 真实点击。

## 4. 填 React 受控输入框
用原生 value setter + dispatch input，不能用 `.value=` 直接赋值：
```
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
setter.call(el, 'xxx');
el.dispatchEvent(new Event('input',{bubbles:true}));
```

## 5. 首页 JS 主线程死锁（历史坑，已规避）
- 症状：冷启动后 `Target.createTarget` 触发整页卡死。根因：`Default/Sessions` + `Sessions_Encrypted` 恢复 fxg 标签拖垮浏览器。
- 规避：删除上述两个文件后冷启动；且**不要恢复旧的 fxg 标签**。

## 6. Node / 运行时约束
- Node 22 全局 `WebSocket` 用 **EventTarget API**：`addEventListener('open')` / `addEventListener('message', ev=>ev.data)`，不是 `.on()`。要求 **Node ≥ 22**（内置 WebSocket）；若用旧 Node 需自行安装 `ws` 模块并经 `DD_WS_PATH` 指定路径。
- `.mjs` 文件不能用 `require`，需用 `.cjs` 或改 `import`；本技能混合使用（启动/登录用 .mjs，步骤用 .cjs）。
- 脚本内所有机器相关路径均可经环境变量覆盖（见 SKILL.md「环境与路径配置」），公开仓库不含任何本机绝对路径。
