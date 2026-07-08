// 抖店交易明细（成交分析）下载脚本
// 用法: node transaction-download.mjs <browserWsUrl> [--date YYYYMMDD] [--brand 品牌名]
//
// 说明:
//   电商罗盘顶部导航「交易」→「全店成交分析」页，点「下载明细」→「下载当前明细」，
//   导出 xlsx（抖音电商罗盘-成交分析-YYYYMMDD-YYYYMMDD.xlsx），归档为 日期_品牌_交易明细.xlsx。
//   日期默认选「近1天」(value=one)，在罗盘中等同于“昨天”，与日报约定一致。
//
// 示例:
//   node transaction-download.mjs ws://localhost:9222/devtools/browser/xxx
//   node transaction-download.mjs ws://localhost:9222/devtools/browser/xxx --date 20260707 --brand 品牌B

import WebSocket from 'ws';
import { execSync, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BRAND_FULL_NAMES, BRAND_KEYWORDS } from './config.js';

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
      if (idx >= 0) { const [evt] = this.events.splice(idx, 1); return evt; }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for ${method}`);
  }
  peekEvents() { return [...this.events]; }
  drainEvents() { this.events = []; }
  close() { this.ws.close(); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 店铺视角切换 =====
// 交易明细导出文件名不含品牌（抖音电商罗盘-成交分析-日期-日期.xlsx），
// 归档时再加品牌前缀，因此下载前必须把浏览器数据视角切到正确店铺，否则会下错数据。
// 品牌简称 → 店铺全名（从 config.js 导入 BRAND_FULL_NAMES）

// ===== 品牌内容校验（防伪串味）=====
// 交易明细导出文件名不含品牌，仅靠店铺视角/快照仍可能出错。
// 用户提供的判定方法：商品构成 sheet 内含商品交易数据，可用商品名判断归属品牌。
// 实现：提取商品名后做“排斥匹配”——只要出现非目标品牌的特征词即判定串味、拒绝归档。
// 零成交日导出为空模板（仅含“日期”无商品名），则降级为告警跳过。
const PYTHON = process.env.PYTHON_VENV || 'python';
const EXTRACT_SCRIPT = path.join(__dirname, 'extract-products.py');

// 品牌 → 商品名特征词（从 config.js 导入 BRAND_KEYWORDS）

function extractProducts(xlsxPath) {
  return new Promise((resolve) => {
    execFile(PYTHON, [EXTRACT_SCRIPT, xlsxPath], { timeout: 30000 }, (err, stdout) => {
      if (err) { console.error('[VERIFY] 提取商品名失败:', err.message); resolve(null); return; }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { console.error('[VERIFY] 解析提取结果失败'); resolve(null); }
    });
  });
}

// 返回 { ok, reason, empty?, skipped?, hitTarget? }
function verifyBrand(data, targetBrand) {
  if (!data) return { ok: true, skipped: true, reason: '提取失败，跳过内容校验' };
  const products = data.products || [];
  const sample = data.sample || [];
  const corpus = products.length ? products : sample; // 商品构成为空时兜底用全表商品词样本
  if (!corpus.length) {
    return { ok: true, empty: true, reason: '文件中无任何商品名（零成交/空模板），无法用内容校验' };
  }
  // 排斥检查：出现非目标品牌的特征词 -> 串味
  for (const [brand, kws] of Object.entries(BRAND_KEYWORDS)) {
    if (brand === targetBrand) continue;
    for (const kw of kws) {
      if (corpus.some(p => p.includes(kw))) {
        return { ok: false, reason: `文件中出现其他品牌[${brand}]的特征词"${kw}"，疑似串味` };
      }
    }
  }
  // 正向确认：是否命中目标品牌关键词
  const tkw = BRAND_KEYWORDS[targetBrand] || [];
  const hitTarget = tkw.some(kw => corpus.some(p => p.includes(kw)));
  return { ok: true, hitTarget };
}

async function switchStore(browserWs, targetBrand) {
  const fullName = BRAND_FULL_NAMES[targetBrand];
  if (!fullName) {
    console.log(`[SWITCH] 未知品牌"${targetBrand}"，跳过切换`);
    return false;
  }
  console.log(`[SWITCH] 切换数据视角 → ${fullName}`);
  const browser = new CDPClient(browserWs);
  await browser.connect();
  try {
    const res = await browser.send('Target.createTarget', { url: 'https://compass.jinritemai.com/shop' });
    const pageWs = `ws://localhost:9222/devtools/page/${res.result.targetId}`;
    const page = new CDPClient(pageWs);
    await page.connect();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.waitFor('Page.loadEventFired');
    await sleep(4000);

    // 预判断：当前已是目标品牌则跳过（避免重复进入切换弹窗）
    const cur = await page.eval(`(function(){var n=document.querySelector('.userName-zP35aZ');return n?n.textContent.trim():'UNKNOWN';})()`);
    if (cur && cur.includes(fullName.substring(0, 4))) {
      console.log(`[SWITCH] 当前已是 ${cur}，无需切换`);
      page.close(); browser.close();
      return true;
    }

    // 1. Hover 右上角店铺名
    console.log('[SWITCH] 1/4 Hover 店铺名...');
    const coords = await page.eval(`
      (function() {
        var t = document.querySelector('.userDropDown-k9_W5P');
        if (!t) return null;
        var r = t.getBoundingClientRect();
        return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
      })()
    `);
    if (!coords) throw new Error('找不到用户下拉触发区');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await sleep(1500);

    // 2. Fiber 点击 "切换数据视角"
    console.log('[SWITCH] 2/4 点击切换数据视角...');
    const switchClick = await page.eval(`
      (function() {
        var el = document.querySelector('.switchAccount-jAhEuJ');
        if (!el) return 'NOT_FOUND';
        var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber'); });
        if (!fiberKey) return 'NO_FIBER';
        var fiber = el[fiberKey];
        if (fiber.memoizedProps && typeof fiber.memoizedProps.onClick === 'function') {
          fiber.memoizedProps.onClick({ stopPropagation: function(){}, preventDefault: function(){} });
          return 'OK';
        }
        return 'NO_HANDLER';
      })()
    `);
    if (switchClick !== 'OK') throw new Error(`点击切换失败: ${switchClick}`);
    await sleep(2000);

    // 3. 等待弹窗并点击目标品牌
    console.log('[SWITCH] 3/4 选择品牌...');
    const brandClick = await page.eval(`
      (function() {
        var fullName = '${fullName}';
        var items = document.querySelectorAll('.index_roleItem__3R8yT');
        for (var i = 0; i < items.length; i++) {
          var name = items[i].querySelector('.index_introName__2tsRs');
          if (name && name.textContent.indexOf(fullName) >= 0) {
            var fiberKey = Object.keys(items[i]).find(function(k) { return k.startsWith('__reactFiber'); });
            if (!fiberKey) return 'NO_FIBER';
            var fiber = items[i][fiberKey];
            if (fiber.memoizedProps && typeof fiber.memoizedProps.onClick === 'function') {
              fiber.memoizedProps.onClick({ stopPropagation: function(){}, preventDefault: function(){} });
              return 'OK';
            }
            return 'NO_HANDLER';
          }
        }
        return 'NOT_FOUND';
      })()
    `);
    if (brandClick !== 'OK') throw new Error(`选择品牌失败: ${brandClick}`);
    await sleep(4000);

    // 4. 验证切换成功
    const verify = await page.eval(`
      (function() {
        var n = document.querySelector('.userName-zP35aZ');
        return n ? n.textContent.trim() : '???';
      })()
    `);
    console.log(`[SWITCH] 4/4 验证: ${verify}`);
    page.close(); browser.close();
    return verify && verify.includes(fullName.substring(0, 4));
  } catch (e) {
    console.error(`[SWITCH] ❌ 切换失败: ${e.message}`);
    browser.close();
    return false;
  }
}

// 选择日期 radio（复用商品页的派发方式；交易页 value=one=近1天=昨天）
const selectDateRadio = (value) => `
(function() {
  var inp = document.querySelector('input[type=radio][value="${value}"]');
  if (!inp) return 'NO_RADIO_${value}';
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

// 点击顶部导航「交易」(aurora-dropdown-trigger menuName-iiOPo5)
const clickTxNav = `
(function() {
  var items = document.querySelectorAll('.menuContent-ruzjHL .menuName-iiOPo5');
  for (var i = 0; i < items.length; i++) {
    if (items[i].textContent.trim() === '交易') {
      var fk = Object.keys(items[i]).find(function(k) { return k.startsWith('__reactFiber'); });
      if (fk) {
        var node = items[i][fk];
        while (node) {
          if (node.memoizedProps && typeof node.memoizedProps.onClick === 'function') {
            node.memoizedProps.onClick({ stopPropagation: function(){}, preventDefault: function(){}, nativeEvent: new MouseEvent('click') });
            return 'OK';
          }
          node = node.return;
        }
      }
      items[i].click();
      return 'NATIVE';
    }
  }
  return 'NOT_FOUND';
})()
`;

// 打开「下载明细」下拉 (.ecom-dropdown-trigger)
const openDownloadDropdown = `
(function() {
  var els = [].slice.call(document.querySelectorAll('.ecom-dropdown-trigger')).filter(function(e) { return e.textContent.indexOf('下载明细') >= 0; });
  if (!els.length) return 'NO_TRIGGER';
  els[0].click();
  return 'OPENED';
})()
`;

// 点击「下载当前明细」菜单项（fiber onClick）
const clickDownloadCurrent = `
(function() {
  var items = [].slice.call(document.querySelectorAll('.ecom-dropdown-menu-item'));
  var target = items.find(function(i) { return i.textContent.indexOf('下载当前明细') >= 0; })
            || items.find(function(i) { return i.textContent.indexOf('明细') >= 0; });
  if (!target) return 'ITEM_NOT_FOUND';
  var fk = Object.keys(target).find(function(k) { return k.startsWith('__reactFiber'); });
  if (fk) {
    var node = target[fk];
    while (node) {
      if (node.memoizedProps && typeof node.memoizedProps.onClick === 'function') {
        node.memoizedProps.onClick({ stopPropagation: function(){}, preventDefault: function(){}, nativeEvent: new MouseEvent('click') });
        return 'CLICKED_VIA_FIBER';
      }
      node = node.return;
    }
  }
  target.click();
  return 'CLICKED_NATIVE';
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
    BROWSER_WS = JSON.parse(res).webSocketDebuggerUrl;
    console.log('[AUTO] Detected BROWSER_WS:', BROWSER_WS);
  } catch {
    console.error('Usage: node transaction-download.mjs <browserWsUrl> [--date YYYYMMDD] [--brand 品牌名]');
    console.error('  or set BROWSER_WS environment variable');
    process.exit(1);
  }
}
if (!DATE) DATE = execSync('bash -c \'date -d yesterday "+%Y%m%d"\'', { encoding: 'utf-8' }).trim();

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const ARCHIVE_SCRIPT = path.join(__dirname, 'archive.sh');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const SOURCE_PATTERN = `抖音电商罗盘-成交分析-*${DATE}*.xlsx`;

console.log(`[CONFIG] BRAND=${BRAND} DATE=${DATE} BROWSER_WS=${BROWSER_WS.substring(0, 50)}...`);

// 轮询 ~/Downloads，等待一个“本次新下载”的文件出现。
// 关键：交易明细导出文件名不含品牌（抖音电商罗盘-成交分析-日期-日期.xlsx），
// 同一天可能已有旧文件（其他品牌 / 上次运行）。若直接取“最新修改”会误匹配旧文件，
// 因此采用快照法——只认点击下载后才出现的新文件。
async function waitForNewFile(snapshot, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.includes('抖音电商罗盘-成交分析-') && f.includes(DATE) && f.endsWith('.xlsx') && !snapshot.includes(f))
        .map(f => ({ f, mtime: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length) {
        const candidate = files[0].f;
        const tmp = path.join(DOWNLOADS_DIR, candidate + '.crdownload');
        if (!fs.existsSync(tmp)) return candidate;
      }
    } catch {}
    await sleep(1500);
  }
  return null;
}

// 归档：先复制到 .part 临时文件，再 rename 到最终名。
// 规避两类锁：① 源(刚下载)被下载器/索引短暂占用 -> 复制重试；
// ② 目标被 Excel 打开(项目里正在查看) -> rename 失败重试，源数据不丢。
async function safeArchive(src, dst, maxAttempts = 60) {
  const part = dst + '.part';
  for (let i = 0; i < maxAttempts; i++) {
    try {
      fs.copyFileSync(src, part);
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM') {
        console.log(`[12] 源文件被锁定，重试 (${i + 1}/${maxAttempts})...`);
        await sleep(2000);
        continue;
      }
      throw e;
    }
    try {
      fs.renameSync(part, dst);
      return;
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM') {
        console.log(`[12] 目标文件被占用（可能 Excel 正打开 ${path.basename(dst)}），请关闭后自动重试 (${i + 1}/${maxAttempts})...`);
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
  try { fs.unlinkSync(part); } catch {}
  throw new Error('归档失败：文件持续被锁定（若目标被 Excel 打开，请先关闭该文件再重试） ' + dst);
}

// ===== 主流程 =====
async function main() {
  const browser = new CDPClient(BROWSER_WS);
  await browser.connect();
  console.log('[0] Connected to browser');

  // 先确保数据视角为当前品牌（交易明细文件名不含品牌，必须切对再下载）
  const switched = await switchStore(BROWSER_WS, BRAND);
  if (!switched) {
    console.error('[ERROR] 切换店铺视角失败:', BRAND);
    browser.close();
    process.exit(1);
  }

  const res = await browser.send('Target.createTarget', {
    url: 'https://compass.jinritemai.com/shop'
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
  await sleep(3000);

  const title0 = await page.eval('document.title');
  console.log('[4] Page title:', title0);

  // 点击顶部「交易」导航
  const navResult = await page.eval(clickTxNav);
  console.log('[5] Click 交易 nav:', navResult);
  await sleep(4000);

  const title = await page.eval('document.title');
  console.log('[6] Page title after nav:', title);
  if (!title || !title.includes('成交分析')) {
    console.error('[ERROR] Title does not contain 成交分析, got:', title);
    page.close(); browser.close();
    process.exit(1);
  }

  // 选「近1天」
  const timeResult = await page.eval(selectDateRadio('one'));
  console.log('[7] Set 近1天:', timeResult);
  await sleep(2000);

  // 打开「下载明细」下拉
  const dropdownResult = await page.eval(openDownloadDropdown);
  console.log('[8] Open 下载明细:', dropdownResult);
  if (dropdownResult === 'NO_TRIGGER') {
    console.error('[ERROR] Could not find 下载明细 trigger');
    page.close(); browser.close();
    process.exit(1);
  }
  await sleep(1500);

  // 点击「下载当前明细」前，记录 Downloads 中已存在的同日期文件快照
  const snapshot = fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => f.includes('抖音电商罗盘-成交分析-') && f.includes(DATE) && f.endsWith('.xlsx'));

  // 点击「下载当前明细」
  const clickResult = await page.eval(clickDownloadCurrent);
  console.log('[9] Click 下载当前明细:', clickResult);
  if (clickResult === 'ITEM_NOT_FOUND') {
    console.error('[ERROR] Could not find 下载当前明细 menu item');
    page.close(); browser.close();
    process.exit(1);
  }

  console.log('[10] Waiting for NEW download file (snapshot=' + snapshot.length + ' existing) ...');
  const file = await waitForNewFile(snapshot, 90000);
  if (!file) {
    console.error('[ERROR] New download file not found in', DOWNLOADS_DIR, 'within 90s');
    page.close(); browser.close();
    process.exit(1);
  }
  console.log('[11] Download ready:', file);

  // 内容级品牌校验：读取「商品构成」商品名做排斥匹配，防止串味错标
  console.log('[11.5] 校验文件归属品牌（商品构成商品名）...');
  const prodData = await extractProducts(path.join(DOWNLOADS_DIR, file));
  const verdict = verifyBrand(prodData, BRAND);
  console.log('[11.5] verdict:', JSON.stringify(verdict));
  if (!verdict.ok) {
    console.error('[ERROR] 品牌校验未通过:', verdict.reason);
    console.error('[ERROR] 已保留原始文件于 Downloads，未归档，请人工核查。');
    page.close(); browser.close();
    process.exit(1);
  }
  if (verdict.empty || verdict.skipped) {
    console.log('[WARN] 无法进行内容级品牌校验（' + (verdict.reason || '') + '），依赖店铺视角+快照。');
  }

  page.close();
  browser.close();

  // 归档：先复制到 .part 再 rename 到项目目录（不用 archive.sh 的 ls -t，避免误匹配旧文件）
  const targetDir = path.join(PROJECT_DIR, DATE);
  const targetFile = path.join(targetDir, `${DATE}_${BRAND}_交易明细.xlsx`);
  fs.mkdirSync(targetDir, { recursive: true });
  const srcFile = path.join(DOWNLOADS_DIR, file);
  await safeArchive(srcFile, targetFile, 60);
  const size = fs.statSync(targetFile).size;
  console.log(`[12] Archived -> ${targetFile} (${size} bytes)`);

  console.log('[13] Done.');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
