# CDP 连接模式

> **完整可运行示例见 `scripts/product-download.mjs` 和 `scripts/influencer-download.mjs`。**

## 实现方式选择

> **所有复杂流程必须使用 async/await CDPClient 封装，禁止使用回调式事件监听状态机。**
>
> 回调式状态机的常见问题：
> - 多层 WebSocket（browser → page）混杂在一个 handler，漏事件就卡死
> - Page.loadEventFired 与业务逻辑耦合太紧，丢失后没有恢复机制
> - WebSocket 没有 `.once()`，函数重赋值会产生作用域混乱

## 启动 Chrome 远程调试

使用 `scripts/start-chrome.ps1`（推荐）或手动命令：

```powershell
# 脚本方式（推荐）
PowerShell scripts/start-chrome.ps1

# 手动方式
Get-Process "chrome" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222","--no-sandbox","--user-data-dir=$env:LOCALAPPDATA\Google\Chrome\User Data"
```

验证端口：
```bash
curl -s http://localhost:9222/json/version
```

## 获取 Browser WebSocket URL

当 `--remote-debugging-port` 方式启动时，`DevToolsActivePort` 文件不会写入，CDP Proxy 无法通过 `/devtools/browser` 连接。需从 `/json/version` 获取带 UUID 的 WebSocket URL：

```bash
BROWSER_WS=$(curl -s http://localhost:9222/json/version | grep -o '"webSocketDebuggerUrl": "[^"]*"' | cut -d'"' -f4)
```

## async/await CDPClient（推荐模式）

封装类代码（放入 `.mjs` 脚本顶部或 `references/` 中复用）：

```js
import WebSocket from 'ws';

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        } else {
          this.events.push(msg);
        }
      });
    });
  }

  async send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.result?.result) return res.result.result.value;
    if (res.result?.exceptionDetails) {
      throw new Error('Eval error: ' + JSON.stringify(res.result.exceptionDetails));
    }
    return null;
  }

  async waitFor(method, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const idx = this.events.findIndex(e => e.method === method);
      if (idx >= 0) {
        const [evt] = this.events.splice(idx, 1);
        return evt;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for ${method}`);
  }

  peekEvents() { return [...this.events]; }
  drainEvents() { this.events = []; }
  close() { this.ws.close(); }
}
```

### 完整用法示例（商品列表下载）

```js
import WebSocket from 'ws';

const BROWSER_WS = 'ws://localhost:9222/devtools/browser/<uuid>';

async function main() {
  // 1. 连接 browser
  const browser = new CDPClient(BROWSER_WS);
  await browser.connect();

  // 2. 创建标签页
  const res = await browser.send('Target.createTarget', {
    url: 'https://compass.jinritemai.com/shop/commodity/product-list'
  });
  const targetId = res.result.targetId;

  // 3. 连接 page target
  const pageWs = `ws://localhost:9222/devtools/page/${targetId}`;
  const page = new CDPClient(pageWs);
  await page.connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  // 4. 等待页面加载
  await page.waitFor('Page.loadEventFired');
  await new Promise(r => setTimeout(r, 3000));

  // 5. 检查页面 → 操作 → 下载...
  const title = await page.eval('document.title');
  console.log('Title:', title);

  // 6. 关闭
  page.close();
  browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
```

### 网络请求拦截（达人列表下载）

```js
// 在 page.connect() 之后启用 Network
await page.send('Network.enable');

// 触发下载（注入 cdp-helpers.js 中的 triggerInfluencerDownload）
await page.eval(triggerInfluencerDownloadCode);

// 轮询事件
let requestId = null;
const start = Date.now();
while (Date.now() - start < 30000) {
  const events = page.peekEvents();
  for (const e of events) {
    if (e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('cooperate/list/download')) {
      requestId = e.params.requestId;
    }
    if (e.method === 'Network.loadingFinished' && e.params.requestId === requestId) {
      const bodyRes = await page.send('Network.getResponseBody', { requestId });
      const buf = bodyRes.result.base64Encoded
        ? Buffer.from(bodyRes.result.body, 'base64')
        : bodyRes.result.body;
      fs.writeFileSync('output.xlsx', buf);
      process.exit(0);
    }
  }
  await new Promise(r => setTimeout(r, 300));
}
```

## 常用 CDP 方法

| 操作 | 方法 | 目标层级 |
|------|------|---------|
| 创建标签页 | `Target.createTarget` | browser |
| 获取标签列表 | `Target.getTargets` | browser |
| 关闭标签页 | `Target.closeTarget` | browser |
| 执行 JS | `Runtime.evaluate` | page |
| 启用 Runtime | `Runtime.enable` | page |
| 页面导航 | `Page.navigate` | page |
| 启用 Page 域 | `Page.enable` | page |
| 截图 | `Page.captureScreenshot` | page |
| 启用 Network | `Network.enable` | page |
| 获取响应体 | `Network.getResponseBody` | page |

### Runtime.evaluate 参数

- `expression`: JS 代码字符串
- `returnByValue: true`: 返回可序列化的值
- `awaitPromise: true`: 等待 Promise resolve

## 避免的问题

- 不要在 bash `-e` 中内联复杂 JS（转义问题），用 `.mjs` 文件执行
- `Runtime.evaluate` 返回在 `data.result.result.value` 中
- Browser WebSocket 每次启动 Chrome 后 UUID 会变
- **不要用回调事件监听做多步骤状态管理**：漏事件、作用域混乱、难以调试
- 直接 URL 导航优于点击 UI 导航（更可靠，cookies 通过 user-data-dir 共享）
- 页面加载后至少等待 3 秒再操作（SPA 需要 hydration 时间）
