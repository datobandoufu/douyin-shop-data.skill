// 抖店达人列表下载脚本
// 用法: node influencer-download.mjs <browserWsUrl> [--date YYYYMMDD] [--brand 品牌名]
//
// 示例:
//   node influencer-download.mjs ws://localhost:9222/devtools/browser/xxx
//   node influencer-download.mjs ws://localhost:9222/devtools/browser/xxx --date 20260707 --brand 品牌B

import WebSocket from 'ws';
import { execSync } from 'child_process';
import fs from 'fs';

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

// 触发达人下载（fiber 遍历 D8 找 onDownload）
const triggerDownload = `
(function() {
  var btn = document.querySelector('.withTooltip-lLfGho');
  if (!btn) return 'NO_DL_BTN';
  var fiberKey = Object.keys(btn).find(function(k) { return k.startsWith('__reactFiber'); });
  if (!fiberKey) return 'NO_FIBER';
  var fiber = btn[fiberKey];
  var node = fiber;
  for (var i = 0; i < 8; i++) node = node.return;
  if (node.memoizedProps && typeof node.memoizedProps.onDownload === 'function') {
    node.memoizedProps.onDownload();
    return 'TRIGGERED_D8';
  }
  // fallback: try D6/D7/D9
  var depths = [6, 7, 9];
  for (var d = 0; d < depths.length; d++) {
    node = fiber;
    for (var j = 0; j < depths[d]; j++) node = node.return;
    if (node.memoizedProps && typeof node.memoizedProps.onDownload === 'function') {
      node.memoizedProps.onDownload();
      return 'TRIGGERED_D' + depths[d];
    }
  }
  return 'NO_ONDOWNLOAD';
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
    console.error('Usage: node influencer-download.mjs <browserWsUrl> [--date YYYYMMDD] [--brand 品牌名]');
    console.error('  or set BROWSER_WS environment variable');
    process.exit(1);
  }
}
if (!DATE) DATE = execSync('bash -c \'date -d yesterday "+%Y%m%d"\'', { encoding: 'utf-8' }).trim();

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const OUTPUT_FILE = `${PROJECT_DIR}/${DATE}/${DATE}_${BRAND}_达人列表.xlsx`;

console.log(`[CONFIG] BRAND=${BRAND} DATE=${DATE} OUTPUT=${OUTPUT_FILE}`);
console.log(`[CONFIG] BROWSER_WS=${BROWSER_WS.substring(0, 50)}...`);

// ===== 主流程 =====
async function main() {
  const browser = new CDPClient(BROWSER_WS);
  await browser.connect();
  console.log('[0] Connected to browser');

  const res = await browser.send('Target.createTarget', {
    url: 'https://compass.jinritemai.com/shop/talent-core-analysis'
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

  // 点击"合作达人" tab
  const tabResult = await page.eval(`
    (function() {
      var tabs = document.querySelectorAll('[role=tab]');
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].textContent.indexOf('合作达人') >= 0) {
          tabs[i].click();
          return 'CLICKED';
        }
      }
      return 'TAB_NOT_FOUND';
    })()
  `);
  console.log('[4] Click 合作达人 tab:', tabResult);
  await new Promise(r => setTimeout(r, 3000));

  const title = await page.eval('document.title');
  console.log('[5] Page title:', title);
  if (!title || !title.includes('合作达人')) {
    console.error('[ERROR] Title does not contain 合作达人, got:', title);
    page.close(); browser.close();
    process.exit(1);
  }

  const timeResult = await page.eval(selectYesterday);
  console.log('[6] Set yesterday:', timeResult);
  await new Promise(r => setTimeout(r, 2000));

  // 启用 Network 监控
  await page.send('Network.enable');
  console.log('[7] Network.enable done');

  const dlResult = await page.eval(triggerDownload);
  console.log('[8] Trigger download:', dlResult);
  if (dlResult === 'NO_ONDOWNLOAD') {
    console.error('[ERROR] Could not find onDownload handler');
    page.close(); browser.close();
    process.exit(1);
  }

  // 轮询 Network 事件，拦截 cooperate/list/download
  console.log('[9] Polling for download request...');
  let requestId = null;
  const start = Date.now();
  let found = false;

  while (Date.now() - start < 30000) {
    const events = page.peekEvents();
    for (const e of events) {
      if (e.method === 'Network.requestWillBeSent' &&
          e.params?.request?.url?.includes('cooperate/list/download')) {
        requestId = e.params.requestId;
        console.log('[10] Found download request');
      }
      if (e.method === 'Network.loadingFinished' && e.params?.requestId === requestId) {
        console.log('[11] Download finished, getting response body...');
        const bodyRes = await page.send('Network.getResponseBody', { requestId });
        const buf = bodyRes.result.base64Encoded
          ? Buffer.from(bodyRes.result.body, 'base64')
          : bodyRes.result.body;

        fs.mkdirSync(`${PROJECT_DIR}/${DATE}`, { recursive: true });
        fs.writeFileSync(OUTPUT_FILE, buf);
        console.log('[12] Written:', OUTPUT_FILE, '(' + buf.length + ' bytes)');
        found = true;
        break;
      }
    }
    if (found) break;
    await new Promise(r => setTimeout(r, 300));
  }

  if (!found) {
    console.error('[ERROR] Did not capture download response within 30s');
    const recent = page.peekEvents().filter(e => e.method?.startsWith('Network'));
    console.log('[DEBUG] Network events:', JSON.stringify(recent.slice(0, 5)));
    page.close(); browser.close();
    process.exit(1);
  }

  page.close();
  browser.close();
  console.log('[13] Done.');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
