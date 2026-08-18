// 多账号抖店数据下载编排脚本
// 同一账号管理多店铺，登录一次，按顺序下载各店铺数据。
// 每个品牌依次下载：商品列表 / 达人列表 / 交易明细（成交分析）。
//
// 用法: node download-all.mjs [--date YYYYMMDD] [--brands 品牌1,品牌2,...]
//
// 示例:
//   node download-all.mjs
//   node download-all.mjs --date 20260706
//   node download-all.mjs --brands 品牌A,品牌B --date 20260706

import WebSocket from 'ws';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_BRANDS, ACCOUNT, BRAND_FULL_NAMES } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 输出根目录：默认当前工作目录，可用环境变量 PROJECT_DIR 覆盖
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
// openpyxl 环境（generate-daily-report.py / extract-products.py 依赖）；
// 默认用 PATH 中的 python，可用环境变量 PYTHON_VENV 指定你的 venv python
const PYTHON = process.env.PYTHON_VENV || 'python';

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
    if (res.result?.exceptionDetails) throw new Error('Eval error: ' + JSON.stringify(res.result.exceptionDetails));
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

// ===== 参数解析 =====
const args = process.argv.slice(2);
let DATE = process.env.DATE;
let BRANDS = process.env.BRANDS ? process.env.BRANDS.split(',') : DEFAULT_BRANDS;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) DATE = args[i + 1];
  if (args[i] === '--brands' && args[i + 1]) BRANDS = args[i + 1].split(',');
}
if (!DATE) DATE = execSync('bash -c \'date -d yesterday "+%Y%m%d"\'', { encoding: 'utf-8' }).trim();

console.log('='.repeat(60));
console.log(` 抖店多账号数据下载`);
console.log(` 日期: ${DATE}  |  品牌: ${BRANDS.join(', ')}`);
console.log('='.repeat(60));

// ===== 账号配置（来自 config.js，建议用环境变量 DOUYIN_EMAIL / DOUYIN_PASSWORD 传入）=====
const EMAIL = ACCOUNT.email;
const PASSWORD = ACCOUNT.password;

// ===== 辅助函数 =====
function getBROWSER_WS() {
  try {
    const res = execSync('curl -s http://localhost:9222/json/version', { encoding: 'utf-8', timeout: 5000 });
    return JSON.parse(res).webSocketDebuggerUrl;
  } catch { return null; }
}

// 品牌简称 → 弹窗中的店铺全名映射（已在 config.js 中定义，从 BRAND_FULL_NAMES 导入）

// 切换到目标品牌的数据视角
async function switchStore(browserWs, targetBrand) {
  const fullName = BRAND_FULL_NAMES[targetBrand];
  if (!fullName) {
    console.log(`  ⚠️ 未知品牌"${targetBrand}"，跳过切换`);
    return false;
  }

  console.log(`  切换数据视角 → ${fullName}`);

  const browser = new CDPClient(browserWs);
  await browser.connect();

  try {
    // 打开 compass 任一页面（需要有一个 page 实例）
    const res = await browser.send('Target.createTarget', { url: 'https://compass.jinritemai.com/shop' });
    const targetId = res.result.targetId;
    const pageWs = `ws://localhost:9222/devtools/page/${targetId}`;
    const page = new CDPClient(pageWs);
    await page.connect();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.waitFor('Page.loadEventFired');
    await new Promise(r => setTimeout(r, 4000));

    // 1. Hover 右上角店铺名
    console.log('    1/4 Hover 店铺名...');
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
    await new Promise(r => setTimeout(r, 1500));

    // 2. Fiber 点击 "切换数据视角"
    console.log('    2/4 点击切换数据视角...');
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
    await new Promise(r => setTimeout(r, 2000));

    // 3. 等待弹窗并点击目标品牌
    console.log('    3/4 选择品牌...');
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
    await new Promise(r => setTimeout(r, 4000));

    // 4. 验证切换成功
    const verify = await page.eval(`
      (function() {
        var n = document.querySelector('.userName-zP35aZ');
        return n ? n.textContent.trim() : '???';
      })()
    `);
    console.log(`    4/4 验证: ${verify}`);

    page.close();
    browser.close();
    return verify && verify.includes(fullName.substring(0, 4));
  } catch (e) {
    console.error(`   ❌ 切换失败: ${e.message}`);
    browser.close();
    return false;
  }
}

async function ensureLogin(browserWs) {
  const browser = new CDPClient(browserWs);
  await browser.connect();

  const res = await browser.send('Target.createTarget', {
    url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index'
  });
  const targetId = res.result.targetId;

  const pageWs = `ws://localhost:9222/devtools/page/${targetId}`;
  const page = new CDPClient(pageWs);
  await page.connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.waitFor('Page.loadEventFired');
  await new Promise(r => setTimeout(r, 4000));

  const title = await page.eval('document.title');
  console.log(`  页面标题: ${title}`);

  if (title && title.includes('首页')) {
    console.log('  ✅ 已登录');
    page.close();
    browser.close();
    return true;
  }

  console.log('  ⚠️ 需要登录...');
  // Navigate to login
  await browser.send('Target.closeTarget', { targetId });
  const loginRes = await browser.send('Target.createTarget', {
    url: 'https://fxg.jinritemai.com/login/common'
  });
  const loginWs = `ws://localhost:9222/devtools/page/${loginRes.result.targetId}`;
  const loginPage = new CDPClient(loginWs);
  await loginPage.connect();
  await loginPage.send('Page.enable');
  await loginPage.send('Runtime.enable');
  await loginPage.waitFor('Page.loadEventFired');
  await new Promise(r => setTimeout(r, 4000));

  // Switch to email
  await loginPage.eval(`
    (function() {
      var btns = document.querySelectorAll('.account-center-switch-button');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].textContent.indexOf('邮箱登录') >= 0) { btns[i].click(); return 'OK'; }
      }
      return 'NO_BTN';
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));

  // Fill credentials
  const fillResult = await loginPage.eval(`
    (function() {
      function setNativeValue(el, value) {
        var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var email = document.querySelector('input[type=text], input[name=account], input[placeholder*="邮箱"]') ||
                  document.querySelectorAll('input')[0];
      var pwd = document.querySelector('input[type=password]');
      if (!email || !pwd) return 'NO_INPUTS';
      setNativeValue(email, '${EMAIL}');
      setNativeValue(pwd, '${PASSWORD}');
      var cb = document.querySelector('input[type=checkbox]');
      if (cb && !cb.checked) cb.click();
      var btns = document.querySelectorAll('button');
      for (var j = 0; j < btns.length; j++) {
        if (btns[j].textContent.indexOf('登录') >= 0) { btns[j].click(); return 'SUBMITTED'; }
      }
      return 'FILLED_NO_SUBMIT';
    })()
  `);
  console.log(`  登录提交: ${fillResult}`);
  await new Promise(r => setTimeout(r, 4000));

  // Re-check
  const afterLogin = await loginPage.eval('document.title');
  console.log(`  登录后标题: ${afterLogin}`);
  loginPage.close();
  browser.close();
  return afterLogin && afterLogin.includes('首页');
}

// 探测当前登录后默认的店铺视角
async function getCurrentStore(browserWs) {
  const browser = new CDPClient(browserWs);
  await browser.connect();

  const res = await browser.send('Target.createTarget', {
    url: 'https://compass.jinritemai.com/shop'
  });
  const pageWs = `ws://localhost:9222/devtools/page/${res.result.targetId}`;
  const page = new CDPClient(pageWs);
  await page.connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.waitFor('Page.loadEventFired');
  await new Promise(r => setTimeout(r, 4000));

  const storeName = await page.eval(`
    (function() {
      var n = document.querySelector('.userName-zP35aZ');
      return n ? n.textContent.trim() : 'UNKNOWN';
    })()
  `);
  console.log(`  当前店铺: ${storeName}`);

  // 映射回品牌简称
  const storeToBrand = {};
  for (const [brand, full] of Object.entries(BRAND_FULL_NAMES)) {
    storeToBrand[full] = brand;
  }
  const brand = storeToBrand[storeName] || null;

  page.close();
  browser.close();
  return { storeName, brand };
}

function runDownload(type, brand, date, browserWs) {
  const script = type === 'product'
    ? path.join(__dirname, 'product-download.mjs')
    : type === 'influencer'
    ? path.join(__dirname, 'influencer-download.mjs')
    : path.join(__dirname, 'transaction-download.mjs');

  const cmd = `node "${script}" "${browserWs}" --date ${date} --brand "${brand}"`;
  console.log(`  执行: ${type} --brand ${brand}`);
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error(`  ❌ ${type} ${brand} 失败: ${e.message}`);
    return false;
  }
}

// 生成「日期_品牌_日报.xlsx」：聚合交易明细(成交概览/自营成交)、商品列表、达人列表
function runDailyReport(brand, date) {
  const script = path.join(__dirname, 'generate-daily-report.py');
  const cmd = `"${PYTHON}" "${script}" --date ${date} --brand "${brand}"`;
  console.log(`  执行: 日报 --brand ${brand}`);
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error(`  ❌ 日报 ${brand} 失败: ${e.message}`);
    return false;
  }
}

// ===== 主流程 =====
async function main() {
  // Step 0: Ensure Chrome is ready
  let browserWs = getBROWSER_WS();
  if (!browserWs) {
    console.log('\n[步骤 0] 启动 Chrome...');
    execSync('PowerShell scripts/start-chrome.ps1', { encoding: 'utf-8', stdio: 'inherit' });
    browserWs = getBROWSER_WS();
    if (!browserWs) {
      console.error('❌ Chrome 启动失败');
      process.exit(1);
    }
  }
  console.log(`[步骤 0] Chrome 就绪`);

  // Step 1: Login once
  console.log('\n[步骤 1] 登录检测...');
  const loggedIn = await ensureLogin(browserWs);
  if (!loggedIn) {
    console.error('❌ 登录失败，请手动检查（可能需要滑块验证）');
    process.exit(1);
  }

  // Step 1.5: 检测当前店铺视角，决定首次是否需要切换
  console.log('\n[步骤 1.5] 检测当前店铺...');
  const currentStore = await getCurrentStore(browserWs);
  const firstBrand = BRANDS[0];
  const needsFirstSwitch = currentStore.brand !== firstBrand;

  if (needsFirstSwitch) {
    console.log(`  ⚠️ 当前为"${currentStore.storeName}"，需切换到"${firstBrand}"`);
  } else {
    console.log(`  ✅ 当前已是"${firstBrand}"，无需切换`);
  }

  // Step 2-N: Download for each brand
  const results = [];
  for (let idx = 0; idx < BRANDS.length; idx++) {
    const brand = BRANDS[idx];
    console.log(`\n[品牌 ${idx + 1}/${BRANDS.length}] ${brand}`);
    console.log('-'.repeat(40));

    // Switch store when needed: first brand if current differs, or between brands
    const shouldSwitch = (idx === 0 && needsFirstSwitch) || (idx > 0);
    if (shouldSwitch) {
      const switched = await switchStore(browserWs, brand);
      if (!switched) {
        results.push({ brand, productOk: false, influencerOk: false });
        continue;
      }
    }

    // Product list
    const productOk = runDownload('product', brand, DATE, browserWs);

    // Influencer list
    const influencerOk = runDownload('influencer', brand, DATE, browserWs);

    // Transaction detail (成交分析)
    const transactionOk = runDownload('transaction', brand, DATE, browserWs);

    // Daily report (日报) —— 三表齐全才生成
    let dailyOk = false;
    if (productOk && influencerOk && transactionOk) {
      dailyOk = runDailyReport(brand, DATE);
    } else {
      console.log('  ⚠️ 源文件不完整，跳过日报生成');
    }

    results.push({ brand, productOk, influencerOk, transactionOk, dailyOk });
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(' 执行结果');
  console.log('='.repeat(60));
  let failures = 0;
  for (const r of results) {
    const status = (r.productOk && r.influencerOk && r.transactionOk && r.dailyOk) ? '✅' : '❌';
    console.log(` ${status} ${r.brand}`);
    console.log(`    商品列表: ${r.productOk ? 'OK' : 'FAIL'}`);
    console.log(`    达人列表: ${r.influencerOk ? 'OK' : 'FAIL'}`);
    console.log(`    交易明细: ${r.transactionOk ? 'OK' : 'FAIL'}`);
    console.log(`    日报    : ${r.dailyOk ? 'OK' : 'FAIL'}`);
    if (!r.productOk || !r.influencerOk || !r.transactionOk || !r.dailyOk) failures++;
  }

  console.log(`\n输出目录: ${PROJECT_DIR}/${DATE}/`);
  execSync(`ls -la "${PROJECT_DIR}/${DATE}/"`, { encoding: 'utf-8', stdio: 'inherit' });

  if (failures > 0) {
    console.log(`\n⚠️  ${failures}/${BRANDS.length} 个品牌有失败项`);
    process.exit(1);
  }
  console.log(`\n✅ 全部完成 (${BRANDS.length} 个品牌)`);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
