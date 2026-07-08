// 抖店商品列表下载脚本
// 用法: node product-download.mjs <browserWsUrl> [--date YYYYMMDD] [--brand 品牌名]
//
// 示例:
//   node product-download.mjs ws://localhost:9222/devtools/browser/xxx
//   node product-download.mjs ws://localhost:9222/devtools/browser/xxx --date 20260707 --brand 品牌B

import WebSocket from 'ws';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== CDPClient 封装 =====
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

// ===== CDP 注入片段 =====
const selectYesterday = `
(function() {
  var inp = document.querySelector('input[type=radio][value=one]');
  if (!inp) return 'NO_RADIO_ONE';
  var r = inp.getBoundingClientRect();
  var cx = r.left + r.width / 2;
  var cy = r.top + r.height / 2;
  var opts = { bubbles: true, cancelable: true, view: window };
  inp.dispatchEvent(new MouseEvent('mousedown', Object.assign({ clientX: cx, clientY: cy, button: 0 }, opts)));
  inp.dispatchEvent(new MouseEvent('mouseup',   Object.assign({ clientX: cx, clientY: cy, button: 0 }, opts)));
  inp.dispatchEvent(new MouseEvent('click',     Object.assign({ clientX: cx, clientY: cy, button: 0 }, opts)));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  var active = document.querySelector('.ecom-radio-button-wrapper-checked');
  return active ? 'OK ' + active.textContent.trim() : 'FAIL_TO_VERIFY';
})()
`;

// 打开下载下拉（fiber 遍历 D5 找 onPopupVisibleChange）
const openDropdown = `
(function() {
  var btn = document.querySelector('.downloadDrop-kGtGGo');
  if (!btn) return 'NO_DOWNLOAD_BTN';
  var fiberKey = Object.keys(btn).find(function(k) { return k.startsWith('__reactFiber'); });
  if (!fiberKey) return 'NO_FIBER_ON_BTN';
  var fiber = btn[fiberKey];
  var node = fiber;
  for (var i = 0; i < 5; i++) node = node.return;
  if (node.memoizedProps && typeof node.memoizedProps.onPopupVisibleChange === 'function') {
    node.memoizedProps.onPopupVisibleChange(true);
    return 'OPENED_D5';
  }
  // fallback: try D4/D6
  node = fiber;
  for (var i = 0; i < 4; i++) node = node.return;
  if (node.memoizedProps && typeof node.memoizedProps.onPopupVisibleChange === 'function') {
    node.memoizedProps.onPopupVisibleChange(true);
    return 'OPENED_D4';
  }
  node = fiber;
  for (var i = 0; i < 6; i++) node = node.return;
  if (node.memoizedProps && typeof node.memoizedProps.onPopupVisibleChange === 'function') {
    node.memoizedProps.onPopupVisibleChange(true);
    return 'OPENED_D6';
  }
  return 'ALL_FAILED';
})()
`;

// 点击"下载当前明细"（fiber onClick）
const clickDownloadCurrent = `
(function() {
  var targetText = '下载当前明细';
  var items = document.querySelectorAll('.ecom-dropdown-menu-item');
  for (var i = 0; i < items.length; i++) {
    if (items[i].textContent.indexOf(targetText) >= 0) {
      var fiberKey = Object.keys(items[i]).find(function(k) { return k.startsWith('__reactFiber'); });
      if (!fiberKey) return 'NO_FIBER_ON_ITEM';
      var fiber = items[i][fiberKey];
      var node = fiber;
      while (node) {
        if (node.memoizedProps && typeof node.memoizedProps.onClick === 'function') {
          node.memoizedProps.onClick({
            stopPropagation: function() {},
            preventDefault: function() {},
            nativeEvent: new MouseEvent('click')
          });
          return 'CLICKED_VIA_FIBER';
        }
        node = node.return;
      }
      return 'NO_FIBER_ONCLICK';
    }
  }
  return 'ITEM_NOT_FOUND';
})()
`;

// ===== 参数解析 =====
const args = process.argv.slice(2);
let BROWSER_WS = args[0] || process.env.BROWSER_WS;
let DATE = process.env.DATE;
let BRAND = process.env.BRAND || '品牌A';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) DATE = args[i + 1];
  if (args[i] === '--brand' && args[i + 1]) BRAND = args[i + 1];
}

if (!BROWSER_WS) {
  try {
    const res = execSync('curl -s http://localhost:9222/json/version', { encoding: 'utf-8', timeout: 5000 });
    const data = JSON.parse(res);
    BROWSER_WS = data.webSocketDebuggerUrl;
    console.log('[AUTO] Detected BROWSER_WS:', BROWSER_WS);
  } catch {
    console.error('Usage: node product-download.mjs <browserWsUrl> [--date YYYYMMDD] [--brand 品牌名]');
    console.error('  or set BROWSER_WS environment variable');
    process.exit(1);
  }
}
if (!DATE) DATE = execSync('bash -c \'date -d yesterday "+%Y%m%d"\'', { encoding: 'utf-8' }).trim();
console.log(`[CONFIG] BRAND=${BRAND} DATE=${DATE} BROWSER_WS=${BROWSER_WS.substring(0, 50)}...`);

// ===== 项目路径 =====
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const ARCHIVE_SCRIPT = path.join(__dirname, 'archive.sh');

// ===== 主流程 =====
async function main() {
  const browser = new CDPClient(BROWSER_WS);
  await browser.connect();
  console.log('[0] Connected to browser');

  const res = await browser.send('Target.createTarget', {
    url: 'https://compass.jinritemai.com/shop/commodity/product-list'
  });
  const targetId = res.result.targetId;
  console.log('[1] Created target:', targetId);

  const pageWs = `ws://localhost:9222/devtools/page/${targetId}`;
  const page = new CDPClient(pageWs);
  await page.connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  console.log('[2] Connected to page');

  await page.waitFor('Page.loadEventFired');
  console.log('[3] Page loaded, waiting 3s for SPA hydration...');
  await new Promise(r => setTimeout(r, 3000));

  const title = await page.eval('document.title');
  console.log('[4] Page title:', title);
  if (!title || !title.includes('商品列表')) {
    console.error('[ERROR] Title does not contain 商品列表, got:', title);
    page.close(); browser.close();
    process.exit(1);
  }

  const timeResult = await page.eval(selectYesterday);
  console.log('[5] Set yesterday:', timeResult);
  await new Promise(r => setTimeout(r, 2000));

  const dropdownResult = await page.eval(openDropdown);
  console.log('[6] Open dropdown:', dropdownResult);
  if (dropdownResult === 'ALL_FAILED') {
    console.error('[ERROR] Could not open dropdown via any fiber depth');
    page.close(); browser.close();
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 1500));

  const clickResult = await page.eval(clickDownloadCurrent);
  console.log('[7] Click download item:', clickResult);
  await new Promise(r => setTimeout(r, 2000));

  console.log('[8] Waiting for download to finish...');
  await new Promise(r => setTimeout(r, 8000));

  page.close();
  browser.close();

  // 归档
  console.log('[9] Archiving...');
  try {
    execSync(`bash "${ARCHIVE_SCRIPT}" 商品列表 ${DATE} ${BRAND}`, { encoding: 'utf-8', stdio: 'inherit' });
  } catch (e) {
    console.error('[ERROR] Archive failed:', e.message);
    process.exit(1);
  }

  console.log('[10] Done.');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
