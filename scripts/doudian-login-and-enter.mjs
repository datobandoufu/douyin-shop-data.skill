#!/usr/bin/env node
/**
 * doudian-login-and-enter.mjs —— 抖店自动化流程·登录并进入后台（第二、三步合并）
 * ----------------------------------------------------------------------------
 * 前置：第一步已执行（9222 端口的 Chrome 已打开并停在抖店相关页面，
 *       且其它标签已清理）。
 *
 * 合并逻辑（智能状态机，不挑起点）：
 *   检测当前页面处于哪种状态：
 *     - 已在后台首页            → 直接成功（受益于登录态保存，第一步后大概率如此）
 *     - 停在「请选择店铺」界面  → 直接选店进入后台
 *     - 停在登录页（含手机号模式）→ 先邮箱登录，再按需选店
 *   登录/选店后轮询等待，最终确保进入抖店后台工作台。
 *
 * 用法：
 *   DOUDIAN_EMAIL=... DOUDIAN_PASSWORD=... node doudian-login-and-enter.mjs
 *   node doudian-login-and-enter.mjs --shop="店铺B"
 *
 * 退出码：0 = 成功进入后台；2 = 未在终态（可重试）；1 = 错误。
 * ----------------------------------------------------------------------------
 */

import http from 'http';
import { createRequire } from 'module';
import { setTimeout as sleep } from 'timers/promises';
const require = createRequire(import.meta.url);

const PORT = 9222;
const EMAIL = process.env.DOUDIAN_EMAIL;
const PASSWORD = process.env.DOUDIAN_PASSWORD;
const arg = process.argv.slice(2).find((a) => a.startsWith('--shop='));
const TARGET_SHOP = arg ? decodeURIComponent(arg.split('=').slice(1).join('=')) : (process.env.DD_SHOP_A || '店铺A');
// 店铺匹配关键词（顶栏品牌名匹配用），来自 DD_SHOP_A / DD_SHOP_B
const SHOP_NAMES = [process.env.DD_SHOP_A || '', process.env.DD_SHOP_B || ''].filter(Boolean);

const getWS = () => {
  if (global.WebSocket) return global.WebSocket;
  try { return require(process.env.DD_WS_PATH || 'ws'); }
  catch (e) { throw new Error('需要 Node >= 22（内置 WebSocket），或通过 DD_WS_PATH 指定 ws 模块路径'); }
};

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let d = ''; res.on('data', (x) => (d += x));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.setTimeout(1500, () => req.destroy(new Error('timeout')));
  });
}
function connect(u) {
  return new Promise((resolve, reject) => {
    const ws = new (getWS())(u);
    ws.addEventListener('open', () => { ws.removeEventListener('error', reject); resolve(ws); });
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('WS 超时')), 8000);
  });
}
// 带重试的 CDP 发送（应对抖店页面的间歇主线程阻塞）
async function cdpRetry(ws, method, params = {}, { timeout = 12000, retries = 6, interval = 1200 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await new Promise((res, rej) => {
        const id = Math.floor(Math.random() * 1e6) + 1;
        const h = (ev) => {
          const raw = ev.data; if (raw == null) return;
          let m2; try { m2 = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString()); } catch { return; }
          if (m2.id === id) { ws.removeEventListener('message', h); res(m2); }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { ws.removeEventListener('message', h); rej(new Error(method + ' 超时')); }, timeout);
      });
      if (r.error) throw new Error(JSON.stringify(r.error));
      return r.result;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await sleep(interval);
    }
  }
  throw lastErr;
}
// 轻量检测：返回 null 表示超时/未拿到结果（由调用方决定重试）
async function evalLight(ws, expr) {
  try {
    const r = await cdpRetry(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true }, { timeout: 8000, retries: 8, interval: 1000 });
    if (r.exceptionDetails) return null;
    return r.result ? r.result.value : null;
  } catch { return null; }
}

// 收尾：关闭所有非抖店标签页
async function cleanupTabs() {
  try {
    const list = await httpGet('/json/list');
    const others = (list || []).filter(t => t.type === 'page' && t.url && !t.url.includes('fxg.jinritemai.com'));
    if (others.length === 0) return;
    console.log('[清理] 关闭 ' + others.length + ' 个非抖店标签页...');
    const version = await httpGet('/json/version');
    if (!version || !version.webSocketDebuggerUrl) return;
    const cws = await connect(version.webSocketDebuggerUrl);
    for (const t of others) {
      await cdpRetry(cws, 'Target.closeTarget', { targetId: t.id }, { retries: 2 }).catch(() => {});
    }
    cws.close();
    console.log('[清理] 完成 ✓');
  } catch (e) { /* 静默 */ }
}

// 状态检测：返回 'backend' | 'shopselect' | 'login' | 'unknown'
async function detectState(ws) {
  const r = await evalLight(ws, `(() => {
    const t = document.body.innerText || '';
    const url = location.href;
    const inBackend = url.includes('/ffa/mshop/homepage/index') || t.includes('抖店工作台');
    const hasEmail = !!document.querySelector('input[name=email]');
    const hasPwd = !!document.querySelector('input[name=password]');
    const shopSelect = /请选择店铺|选择店铺|选择品牌/.test(t);
    const hasShopName = !!document.querySelector('div.index_introName__3LLip');
    const hasEmailSwitch = !!([...document.querySelectorAll('div.account-center-switch-button')].find(e => (e.innerText||'').includes('邮箱登录')));
    const hasPhoneInput = !!document.querySelector('input[name=phone], input[type=tel]');
    return { url, inBackend, hasEmail, hasPwd, shopSelect, hasShopName, hasEmailSwitch, hasPhoneInput };
  })()`);
  if (!r) return 'unknown';
  if (r.shopSelect) return 'shopselect';
  if (r.inBackend) return 'backend';
  if (r.hasEmail || r.hasPwd || r.hasEmailSwitch || r.hasPhoneInput) return 'login';
  return 'unknown';
}
// 带重试的状态检测（页面刚加载/间歇阻塞时用）
async function detectStateWithRetry(ws, times = 4) {
  let s = 'unknown';
  for (let i = 0; i < times; i++) {
    s = await detectState(ws);
    if (s !== 'unknown') break;
    await sleep(2000);
  }
  return s;
}

// ===== 第二步：邮箱登录 =====
async function doLogin(ws) {
  if (!EMAIL || !PASSWORD) {
    throw new Error('缺少凭据：请通过环境变量 DOUDIAN_EMAIL / DOUDIAN_PASSWORD 提供账号密码。');
  }
  // 1) 确保邮箱登录模式
  let hasEmail = await evalLight(ws, `!!document.querySelector('input[name=email]')`);
  if (!hasEmail) {
    console.log('[登录] 当前为手机号模式，切换到「邮箱登录」...');
    // 注意：tab 是 React 受控组件，el.click() 无效，必须真实鼠标点击（2026-08-14 实测修复）
    const pos = await evalLight(ws, `(() => {
      const el = [...document.querySelectorAll('div.account-center-switch-button')].find(e => (e.textContent||'').trim()==='邮箱登录');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    if (pos && pos.x != null) {
      await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { retries: 3 });
      await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, { retries: 3 });
    }
    await sleep(1500);
    hasEmail = await evalLight(ws, `!!document.querySelector('input[name=email]')`);
    if (!hasEmail) throw new Error('切换邮箱登录失败，请检查页面结构是否变化。');
  } else {
    console.log('[登录] 已是邮箱登录模式。');
  }
  // 2) 填账号密码（兼容 React 受控组件）
  console.log('[登录] 填写邮箱账号与密码...');
  await evalLight(ws, `((email, pwd) => {
    const setVal = (sel, val) => {
      const i = document.querySelector(sel);
      if (!i) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(i, val);
      i.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[name=email]', email);
    setVal('input[name=password]', pwd);
  })(${JSON.stringify(EMAIL)}, ${JSON.stringify(PASSWORD)})`);
  // 2.5) 校验填充是否生效
  const filled = await evalLight(ws, `(() => {
    const e = document.querySelector('input[name=email]');
    const p = document.querySelector('input[name=password]');
    return { emailLen: e ? e.value.length : 0, pwdLen: p ? p.value.length : 0 };
  })()`);
  console.log('[登录] 填充校验：邮箱长度=' + (filled ? filled.emailLen : 0) + ' 密码长度=' + (filled ? filled.pwdLen : 0));
  if (!filled || filled.emailLen === 0 || filled.pwdLen === 0) {
    throw new Error('账号/密码未成功写入输入框（React 受控组件问题）。');
  }
  // 3) 勾选用户协议
  console.log('[登录] 勾选用户协议...');
  await evalLight(ws, `(() => {
    const c = document.querySelector('input.auxo-checkbox-input');
    if (c && !c.checked) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
      setter.call(c, true);
      c.dispatchEvent(new Event('click', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  // 4) 点击登录
  console.log('[登录] 点击「登录」...');
  const clicked = await evalLight(ws, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '登录' && (x.className||'').includes('account-center-action-button'));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  if (!clicked) throw new Error('未找到登录按钮。');
}

// ===== 第三步：选店并进后台（真实鼠标点击，避免 el.click() 卡死）=====
async function doSelectShop(ws) {
  await cdpRetry(ws, 'Input.enable', {}, { retries: 3 }).catch(() => {});
  await cdpRetry(ws, 'DOM.enable', {}, { retries: 3 }).catch(() => {});
  const doc = await cdpRetry(ws, 'DOM.getDocument', { depth: 1 }, { timeout: 20000 });
  const root = doc.root.nodeId;
  const q = await cdpRetry(ws, 'DOM.querySelectorAll', { nodeId: root, selector: 'div.index_introName__3LLip' }, { timeout: 20000 });
  const nodeIds = (q && q.nodeIds) || [];
  console.log('[选店] 找到店铺名节点数:', nodeIds.length);
  let pickId = null;
  for (const nid of nodeIds) {
    const oh = await cdpRetry(ws, 'DOM.getOuterHTML', { nodeId: nid }, { timeout: 15000 });
    const txt = (oh.outerHTML || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (txt.includes(TARGET_SHOP)) { pickId = nid; break; }
  }
  if (!pickId) throw new Error('未找到店铺「' + TARGET_SHOP + '」。');
  const bm = await cdpRetry(ws, 'DOM.getBoxModel', { nodeId: pickId }, { timeout: 15000 });
  if (!bm || !bm.model) throw new Error('无法获取店铺坐标。');
  const c = bm.model.content; // [x0,y0,x1,y1,x2,y2,x3,y3]
  const cx = Math.round((c[0] + c[2] + c[4] + c[6]) / 4);
  const cy = Math.round((c[1] + c[3] + c[5] + c[7]) / 4);
  console.log(`[选店] 目标店铺「${TARGET_SHOP}」坐标: (${cx}, ${cy})`);
  console.log('[选店] 真实鼠标点击该坐标...');
  await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 }, { retries: 3 });
  await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 }, { retries: 3 });
  console.log('[选店] 已点击，等待进入抖店后台工作台...');
}

async function main() {
  const list = await httpGet('/json/list');
  const fxg = (list || []).find((t) => t.type === 'page' && (t.url || '').includes('fxg.jinritemai.com'));
  if (!fxg) { console.error('✗ 未找到抖店标签页，请先执行第一步（打开 Chrome + 进入抖店）。'); process.exit(1); }
  console.log('[合并] 定位抖店标签页:', fxg.url);
  const ws = await connect(fxg.webSocketDebuggerUrl);

  let state = await detectStateWithRetry(ws);
  console.log('[合并] 初始状态:', state);

  // 阶段一：停在登录页 → 登录
  if (state === 'login') {
    console.log('[合并] 处于登录页，执行邮箱登录...');
    await doLogin(ws);
    // 轮询等待进入 选店 或 后台（最多 ~27s）
    for (let i = 0; i < 18; i++) {
      await sleep(1500);
      state = await detectState(ws);
      if (state === 'shopselect' || state === 'backend') break;
    }
    console.log('[合并] 登录后状态:', state);
  } else if (state === 'unknown') {
    console.error('✗ 无法判断当前页面状态（页面可能仍在加载或检测超时）。请稍后重试，或在浏览器中确认页面已加载完成。');
    process.exit(1);
  }

  // 阶段二：停在选店页 → 选店进后台
  if (state === 'shopselect') {
    console.log('[合并] 处于选店界面，选择「' + TARGET_SHOP + '」...');
    await doSelectShop(ws);
    // 轮询等待进入后台（最多 ~27s）
    for (let i = 0; i < 18; i++) {
      await sleep(1500);
      state = await detectState(ws);
      if (state === 'backend') break;
    }
    console.log('[合并] 选店后状态:', state);
  }

  // 最终确认：验证品牌是否匹配
  if (state === 'backend') {
    const curBrand = await evalLight(ws, `(() => {
      var el = document.querySelector('.index_userName__16Isl') || document.querySelector('[class*="index_userName"]');
      return el ? el.textContent.trim() : '';
    })()`);
    const targetShort = TARGET_SHOP.substring(0, 2);
    if (curBrand && !curBrand.includes(targetShort) && !TARGET_SHOP.includes(curBrand.substring(0, 2))) {
      console.log('[合并] ⚠ 当前品牌 (' + curBrand + ') 与目标 (' + TARGET_SHOP + ') 不匹配。正在切换...');
      // Hover 品牌名 → 点"切换组织/店铺" → 选目标店铺
      const bp = await evalLight(ws, `(() => {
        var keys=${JSON.stringify(SHOP_NAMES.map(n => n.substring(0, 3)))};
        var all = document.querySelectorAll('*');
        for (var i=0;i<all.length;i++) { var e = all[i]; var t = (e.textContent||'').trim();
          var hit=false; for(var k=0;k<keys.length;k++){ if(keys[k]&&t.indexOf(keys[k])>=0){hit=true;break;} }
          if (hit && e.children.length===0) { var r=e.getBoundingClientRect(); if (r.y<100&&r.x>800) return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}); }
        } return JSON.stringify({nf:1});
      })()`);
      const bpObj = JSON.parse(bp);
      if (bpObj.x) {
        await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: bpObj.x, y: bpObj.y });
        await sleep(1500);
        const sw = await evalLight(ws, `(() => {
          var all = document.querySelectorAll('*');
          for (var i=0;i<all.length;i++) { var e=all[i]; var t=(e.textContent||'').trim(); if (t.indexOf('切换')>=0&&t.indexOf('店铺')>=0&&t.length<20) { var r=e.getBoundingClientRect(); if (r.x>0&&r.y>0) return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}); } }
          return JSON.stringify({nf:1});
        })()`);
        const swObj = JSON.parse(sw);
        if (swObj.x) {
          await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: swObj.x, y: swObj.y, button: 'left', clickCount: 1 }, { retries: 3 });
          await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: swObj.x, y: swObj.y, button: 'left', clickCount: 1 }, { retries: 3 });
          await sleep(3000);
          const ts = await evalLight(ws, `(() => {
            var all = document.querySelectorAll('*'); var cand = [];
            for (var i=0;i<all.length;i++) { var e=all[i]; var t=(e.textContent||'').trim(); if (t==='` + TARGET_SHOP + `' && e.children.length===0) { var r=e.getBoundingClientRect(); if (r.x>200&&r.x<1700&&r.y>100) cand.push({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}); } }
            if (cand.length>0) { cand.sort((a,b)=>b.y-a.y); return JSON.stringify(cand[0]); }
            return JSON.stringify({nf:1});
          })()`);
          const tsObj = JSON.parse(ts);
          if (tsObj.x) {
            await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: tsObj.x, y: tsObj.y, button: 'left', clickCount: 1 }, { retries: 3 });
            await cdpRetry(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: tsObj.x, y: tsObj.y, button: 'left', clickCount: 1 }, { retries: 3 });
            await sleep(5000);
            state = await detectState(ws);
            console.log('[合并] 切换后状态:', state);
          }
        }
      }
    }
  }
  if (state === 'backend') {
    await cleanupTabs();
    console.log('\n✅ 合并流程完成：已成功进入抖店后台（' + TARGET_SHOP + '）。');
    ws.close();
    process.exit(0);
  } else if (state === 'shopselect') {
    console.log('\n⚠️ 仍停留在选店界面，选店点击可能未生效，请在浏览器中确认。');
    ws.close();
    process.exit(2);
  } else if (state === 'login') {
    console.log('\n⚠️ 仍停留在登录页，登录未成功（可能账号密码错误 / 风控）。');
    ws.close();
    process.exit(2);
  } else {
    console.log('\n⚠️ 状态未知（' + state + '），请在浏览器中确认是否已进入后台。');
    ws.close();
    process.exit(2);
  }
}

main().catch((e) => { console.error('✗ 合并流程执行失败:', e.message || e); process.exit(1); });
