// step4-export.cjs — 第四步：商品管理导出 + 归档
// ====================================================================
// 流程：
//   1. 真实点击左侧边栏「商品管理」→ 进入 /g/list
//   2. 点击「导出查询商品」→ 打开右侧边栏
//   3. 点击右侧边栏底部「导出」按钮
//   4. ~3s 后关闭自动弹出的新标签页
//   5. 点击「查看导出记录」→ 进入 /g/excel
//   6. 找到刚导出的记录 → 点击下载
//   7. 归档：取导出记录中的完成时间，减1天作为文件夹/文件名日期
//      命名：{日期}_{品牌}_商品管理导出.xlsx
//
// 全流程：每步之间自动处理推广弹窗（Escape 关闭）
// 用法：node step4-export.cjs
// ====================================================================

const WebSocket = global.WebSocket;
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const CDP_BASE = `http://localhost:${PORT}`;
const PROJECT_DIR = path.join(__dirname, '..');
const BRAND = process.env.DOUDIAN_BRAND || process.env.DD_SHOP_A || '店铺A';
const DL_DIR = process.env.DD_DL_DIR || 'C:/tmp/doudian-dl';

// ====================================================================
// 工具函数
// ====================================================================

function httpGet(p) {
  return new Promise((res, rej) => {
    http.get(CDP_BASE + p, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej).setTimeout(2000, () => rej(new Error('HTTP_TIMEOUT')));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ====================================================================
// CDP 连接（直连 per-target WS）
// ====================================================================

async function connectToFxg() {
  const targets = await httpGet('/json/list');
  const fxg = targets.find(t =>
    t.type === 'page' && t.url && t.url.includes('jinritemai.com') && !t.url.includes('chrome://')
  );
  if (!fxg) throw new Error('NO_FXG_TAB - 请先执行第一步打开 Chrome 并进入抖店');
  if (!fxg.webSocketDebuggerUrl) throw new Error('NO_WS_URL');
  console.log('CONNECTED:', fxg.id.slice(0, 8), fxg.url.slice(0, 80));

  const ws = new WebSocket(fxg.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const timers = new Map();

  function cdpSend(method, params = {}, timeoutMs = 10000) {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        if (pending.has(msgId)) { pending.delete(msgId); rej(new Error('TIMEOUT:' + method)); }
      }, timeoutMs);
      timers.set(msgId, t);
      pending.set(msgId, { res, rej });
    });
  }

  ws.addEventListener('message', ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const pr = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timers.get(msg.id));
      timers.delete(msg.id);
      if (msg.error) pr.rej(new Error(JSON.stringify(msg.error)));
      else pr.res(msg.result);
    }
  });

  await new Promise((r, rej) => {
    ws.addEventListener('open', () => r(), { once: true });
    ws.addEventListener('error', e => rej(e), { once: true });
  });

  // 启用所需域（某些域无 enable 方法，用 catch 兜底）
  await Promise.allSettled([
    cdpSend('Page.enable', {}, 5000),
    cdpSend('Runtime.enable', {}, 5000),
    cdpSend('Network.enable', {}, 5000),
  ]);
  // Input.enable 不存在于 CDP 协议中，Input.dispatchMouseEvent/KeyEvent 无需 enable

  return { ws, send: cdpSend };
}

// ====================================================================
// Runtime.evaluate（带重试）
// ====================================================================

async function evalJS(send, expr, retries = 5, cdpTimeout = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await send('Runtime.evaluate',
        { expression: expr, returnByValue: true, timeout: cdpTimeout }, cdpTimeout + 3000);
      return r.result;
    } catch (e) {
      if (i < retries - 1) await sleep(1200 + i * 300);
    }
  }
  throw new Error('EVAL_FAIL');
}

// ====================================================================
// 弹窗处理
// ====================================================================

async function closePopups(send) {
  // [风控优化 2026-08-13] 降低自动化特征：
  //   - Escape 之间、轮次之间加入随机抖动，模拟真人"看到弹窗→犹豫→按键"节奏；
  //   - DOM 兜底轮次由 3 轮减到 2 轮（每轮已遍历全部匹配元素，2 轮足够覆盖异步弹窗）；
  //   - 关闭按钮选择器合并去重（class* 通配已覆盖大量前缀，去掉等价冗余项）。
  const rnd = (min, max) => min + Math.floor(Math.random() * (max - min));

  // Escape（1 次足够关闭大多数浮层，保留 1 次兜底而非 2 次连发）
  for (let i = 0; i < 2; i++) {
    try { await send('Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 3000); } catch (e) {}
    try { await send('Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 3000); } catch (e) {}
    if (i === 0) await sleep(rnd(200, 450));
  }

  // DOM 兜底：抖店营销/引导弹窗（如「属性自动优化」）不响应 Escape，
  // 其 mask 会拦截所有点击 → 表现为「按钮点了没反应 / SIDEBAR_NOT_OPEN」。
  // 必须直接点关闭 X / 关闭文案 / 或蒙层。选择器覆盖 ecom-g- / auxo- / arco- / 业务自定义。
  for (let round = 0; round < 2; round++) {
    try {
      const r = await send('Runtime.evaluate', {
        expression: `
          (() => {
            function isVisible(el) {
              if (!el) return false;
              const s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
              const r = el.getBoundingClientRect();
              return r.width > 2 && r.height > 2;
            }
            let n = 0;
            // 1) 关闭 X / 关闭按钮（class* 通配已覆盖前缀变体，去重后精简）
            const sels = [
              '.ecom-g-modal-close', '.auxo-modal-close', '.arco-modal-close',
              '[class*="modal-close"]', '[class*="dialog-close"]', '[class*="drawer-close"]',
              '[class*="guide-close"]', '[class*="closeIcon"]', '[class*="close-icon"]',
              '[class*="IconClose"]', '[class*="closeBtn"]', '[class*="close-btn"]',
              '[aria-label="Close"]'
            ];
            for (const s of sels) {
              document.querySelectorAll(s).forEach(e => {
                try { if (isVisible(e)) { e.click(); n++; } } catch (_) {}
              });
            }
            // 2) 文案兜底按钮（避开「立即开启」这类会产生副作用的主行动按钮）
            const safeTexts = ['我知道了', '知道了', '暂不开启', '下次再说', '跳过', '关闭', '不用了', '暂不', '好的', '确认关闭'];
            [...document.querySelectorAll('button,div,span,a')].forEach(e => {
              const t = (e.textContent || '').trim();
              if (safeTexts.some(st => t === st || t.indexOf(st) === 0) && isVisible(e)) {
                try { e.click(); n++; } catch (_) {}
              }
            });
            // 3) 蒙层兜底：某些引导弹窗点背景可关闭，且上面找不到 X
            document.querySelectorAll('.auxo-modal-mask, .arco-modal-mask, .ecom-g-modal-mask, [class*="modal-mask"]').forEach(mask => {
              if (isVisible(mask)) {
                try {
                  const r = mask.getBoundingClientRect();
                  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 });
                  mask.dispatchEvent(ev);
                  n++;
                } catch (_) {}
              }
            });
            return n;
          })()
        `,
        returnByValue: true
      }, 10000);
      const n = r && r.result && r.result.value;
      if (n) console.log('  关闭遮挡弹窗 x' + n);
      if (!n) break;
      await sleep(rnd(400, 900));
    } catch (e) { break; }
  }
  await sleep(rnd(250, 500));
}

// ====================================================================
// 标签页清理：确保仅保留抖店后台标签页
// ====================================================================

async function ensureOnlyDouDianTab() {
  try {
    const targets = await httpGet('/json/list');
    const pages = targets.filter(t => t.type === 'page' && t.url && !t.url.includes('chrome://'));
    const nonFxg = pages.filter(t => !t.url.includes('jinritemai.com'));
    if (nonFxg.length === 0) return;

    console.log('  清理多余标签页 (' + nonFxg.length + ')...');
    const version = await httpGet('/json/version');
    if (!version || !version.webSocketDebuggerUrl) return;

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, rej) => {
      ws.addEventListener('open', () => {
        let closed = 0;
        for (const t of nonFxg) {
          ws.send(JSON.stringify({ id: closed + 1, method: 'Target.closeTarget', params: { targetId: t.id } }));
          closed++;
        }
        setTimeout(() => { try { ws.close(); } catch (e) {} r(); }, 1500);
      }, { once: true });
      ws.addEventListener('error', () => r());
      setTimeout(() => r(), 3000);
    });
    console.log('  已清理 ' + nonFxg.length + ' 个非抖店标签 ✓');
  } catch (e) {
    // 静默失败，不阻塞主流程
  }
}

// ====================================================================
// 文本查找元素（返回 rect 中心坐标）
// ====================================================================

async function findByText(send, text, opts = {}) {
  const { maxLenExtra = 6, minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity,
          sel = 'button,a,[role="button"]' } = opts;
  const safeText = JSON.stringify(text);
  const js = `(function(t,mle,minX,maxX,minY,maxY,qsel){
    function vis(el){
      if(!el) return false;
      var s=window.getComputedStyle(el);
      if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) return false;
      var r=el.getBoundingClientRect();
      if(r.width<=0||r.height<=0) return false;
      if(r.x+r.width<minX||r.x>maxX||r.y+r.height<minY||r.y>maxY) return false;
      return true;
    }
    function rc(el){
      var r=el.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};
    }
    var all=document.querySelectorAll(qsel);
    var m=[];
    for(var i=0;i<all.length;i++){
      var el=all[i]; var tt=(el.textContent||'').trim();
      if(tt){
        var ex=(tt===t); var inc=(tt.indexOf(t)>=0&&tt.length<=t.length+mle);
        var leaf=(el.children.length===0);
        if((ex||inc)&&vis(el)){
          var rv=rc(el);
          if(rv) m.push({rect:rv, txt:tt, isExact:ex, isLeaf:leaf});
        }
      }
    }
    m.sort(function(a,b){
      if(a.isExact!==b.isExact) return b.isExact?1:-1;
      if(a.isLeaf!==b.isLeaf) return b.isLeaf?1:-1;
      return a.txt.length-b.txt.length;
    });
    if(!m.length) return JSON.stringify({found:false});
    var b=m[0];
    return JSON.stringify({found:true, rect:b.rect, txt:b.txt});
  })(${safeText},${maxLenExtra},${minX},${maxX},${minY},${maxY},'${sel}')`;
  const r = await evalJS(send, js, 5, 10000);
  try { return JSON.parse(r.value || '{"found":false}'); } catch (e) { return { found: false }; }
}

async function waitForText(send, text, opts = {}, maxWait = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const r = await findByText(send, text, opts);
    if (r.found && r.rect) return r;
    await sleep(1000);
  }
  return { found: false };
}

// ====================================================================
// 鼠标点击
// ====================================================================

async function clickAt(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 5000);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, 5000);
}

async function clickText(send, text, opts = {}) {
  const info = await findByText(send, text, opts);
  if (!info.found || !info.rect) throw new Error('NOT_FOUND: ' + text);
  console.log('  CLICK "' + text + '" @ (' + info.rect.x + ', ' + info.rect.y + ') [' + info.txt + ']');
  await clickAt(send, info.rect.x, info.rect.y);
  return info;
}

// ====================================================================
// JS click（备用，用于视口外或 React 合成事件需要的场景）
// ====================================================================

async function jsClick(send, text, opts = {}) {
  const { maxLenExtra = 6, sel = 'button,a,[role="button"],span,div',
          minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity } = opts;
  const safeT = JSON.stringify(text), safeS = JSON.stringify(sel);
  const js = `(function(t,mle,qsel,mnX,mxX,mnY,mxY){
    var all=document.querySelectorAll(qsel);
    for(var i=0;i<all.length;i++){
      var el=all[i]; var tt=(el.textContent||'').trim();
      if(tt.indexOf(t)>=0&&tt.length<=t.length+mle){
        var s=window.getComputedStyle(el); var r=el.getBoundingClientRect();
        if(s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0
           &&r.x+r.width>=mnX&&r.x<=mxX&&r.y+r.height>=mnY&&r.y<=mxY){
          el.click(); return JSON.stringify({ok:1,tag:el.tagName,text:tt.slice(0,40)});
        }
      }
    }
    return JSON.stringify({ok:0});
  })(${safeT},${maxLenExtra},${safeS},${minX},${maxX},${minY},${maxY})`;
  try {
    const r = await evalJS(send, js, 4, 8000);
    if (!r || !r.value) return { ok: 0 };
    return typeof r.value === 'string' ? JSON.parse(r.value) : { ok: 1 };
  } catch (e) {
    return { ok: 0, err: e.message };
  }
}

// ====================================================================
// 关闭新标签页
// ====================================================================

async function closeNewPopupTab(existingIds, waitMs = 15000) {
  await sleep(1500);
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const targets = await httpGet('/json/list');
    const pages = targets.filter(t => t.type === 'page' && t.url && !t.url.includes('chrome://'));
    for (const p of pages) {
      if (!existingIds.has(p.id)) {
        console.log('  NEW_TAB:', p.id.slice(0, 8), (p.url || '').slice(0, 80));
        // 连接该标签页并关闭
        if (p.webSocketDebuggerUrl) {
          const tws = new WebSocket(p.webSocketDebuggerUrl);
          await new Promise((r, rej) => {
            tws.addEventListener('open', () => {
              tws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
              setTimeout(() => { try { tws.close(); } catch (e) {} r(); }, 500);
            }, { once: true });
            tws.addEventListener('error', () => r());
            setTimeout(() => r(), 2000);
          });
        }
        // 直接关标签页
        const mainWs = new WebSocket((await httpGet('/json/version')).webSocketDebuggerUrl);
        await new Promise((r, rej) => {
          mainWs.addEventListener('open', () => {
            mainWs.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: p.id } }));
            mainWs.addEventListener('message', () => { try { mainWs.close(); } catch (e) {} r(); }, { once: true });
            setTimeout(() => { try { mainWs.close(); } catch (e) {} r(); }, 3000);
          }, { once: true });
          mainWs.addEventListener('error', () => r());
          setTimeout(() => r(), 3000);
        });
        return p.id;
      }
    }
    await sleep(600);
  }
  console.log('  No popup tab detected');
  return null;
}

// ====================================================================
// 下载文件（Node.js HTTP，带 Cookie）
// ====================================================================

async function downloadFile(send, url, saveDir) {
  let cookieStr = '';
  try {
    const cr = await send('Network.getCookies',
      { urls: [url.split('/').slice(0, 3).join('/') + '/'] }, 5000);
    if (cr && cr.cookies) {
      cookieStr = cr.cookies.map(c => c.name + '=' + c.value).join('; ');
    }
  } catch (e) {}
  if (!cookieStr) {
    try {
      const dc = await evalJS(send, 'document.cookie', 2, 5000);
      if (dc && dc.value) cookieStr = dc.value;
    } catch (e) {}
  }

  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const urlObj = new URL(url);
  const fname = decodeURIComponent(path.basename(urlObj.pathname) || 'export.xlsx');
  const fpath = path.join(saveDir, fname);
  console.log('  Downloading:', fname, cookieStr ? '(with cookies)' : '(no cookies)');

  return new Promise((res, rej) => {
    const mod = urlObj.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    };
    if (cookieStr) headers['Cookie'] = cookieStr;
    const req = mod.get(url, { headers }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log('  Following redirect...');
        downloadFile(send, response.headers.location, saveDir).then(res).catch(rej);
        return;
      }
      if (response.statusCode !== 200) {
        rej(new Error('HTTP ' + response.statusCode + ': ' + url.slice(0, 80)));
        return;
      }
      const wstream = fs.createWriteStream(fpath);
      response.pipe(wstream);
      wstream.on('finish', () => { wstream.close(); res(fpath); });
      wstream.on('error', rej);
    });
    req.setTimeout(180000, () => { req.destroy(); rej(new Error('DL_TIMEOUT')); });
    req.on('error', rej);
  });
}

// ====================================================================
// 解析导出记录中的时间文本
// ====================================================================

function parseRecordTime(s) {
  if (!s) return null;
  try {
    // "2026-07-17 16:30:00" / "2026-07-17 16:30"
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    // "今天 16:30" / "昨天 16:30" / "前天 16:30"
    m = s.match(/(今天|昨天|前天)\D+(\d{1,2}):(\d{2})/);
    if (m) {
      const now = new Date();
      const offset = m[1] === '今天' ? 0 : (m[1] === '昨天' ? -1 : -2);
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, +m[2], +m[3], 0);
    }
    // "07-17 16:30"
    m = s.match(/(\d{1,2})-(\d{1,2})\D+(\d{2}):(\d{2})/);
    if (m) {
      const now = new Date();
      return new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], 0);
    }
  } catch (e) {}
  return null;
}

// ====================================================================
// 主流程
// ====================================================================

async function main() {
  if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

  const { ws, send } = await connectToFxg();

  // 活性检查
  try {
    const a = await evalJS(send, '1+1', 3, 5000);
    console.log('ALIVE:', a.value);
  } catch (e) {
    console.log('Page dead, reloading...');
    await send('Page.reload', {}, 15000);
    await sleep(8000);
  }

  // ================================================================
  // [0] 品牌校验（防污染）：确保当前店铺 == BRAND，否则先切换
  // ================================================================
  const { ensureBrand } = require('./brand-helper.cjs');
  console.log('\n[0] 品牌校验（防污染）...');
  const brandOk = await ensureBrand(send, BRAND);
  if (!brandOk) {
    console.error('  ✗ 品牌校验失败，终止本步以防数据污染（当前非 ' + BRAND + '）');
    ws.close();
    process.exit(1);
  }
  console.log('  ✓ 品牌校验通过：' + BRAND);

  // ================================================================
  // [1/8] 关闭初始弹窗 → 真实点击左侧边栏「商品管理」
  // ================================================================
  console.log('\n[1/8] 关闭弹窗 → 点击侧边栏「商品管理」');
  await closePopups(send);
  await sleep(500);

  // 定位并点击左侧边栏中的「商品管理」
  // 左侧边栏通常在 x < 250 范围内
  let sidebarItem = await findByText(send, '商品管理', {
    maxLenExtra: 1, sel: 'span,div,a,li,[class*="nav"],[class*="menu"],[class*="sidebar"]',
    maxX: 300, maxY: 900
  });
  if (!sidebarItem.found || !sidebarItem.rect) {
    // 放宽 x 范围重试
    sidebarItem = await findByText(send, '商品管理', {
      maxLenExtra: 1, sel: 'span,div,a,li,[class*="nav"],[class*="menu"],[class*="sidebar"]',
      maxX: 400, maxY: 900
    });
  }
  if (!sidebarItem.found || !sidebarItem.rect) {
    throw new Error('NOT_FOUND: 商品管理 in sidebar');
  }
  console.log('  找到侧边栏「商品管理」@ (' + sidebarItem.rect.x + ', ' + sidebarItem.rect.y + ')');
  await clickAt(send, sidebarItem.rect.x, sidebarItem.rect.y);
  await sleep(5000);

  // 确认已进入 /g/list（首次登录后 SPA 路由可能未就绪，需重试+兜底）
  let curURL = (await evalJS(send, 'location.href', 3, 5000)).value || '';
  console.log('  URL:', curURL.slice(0, 90));
  for (let navRetry = 0; !curURL.includes('/g/list') && navRetry < 4; navRetry++) {
    if (navRetry === 0) {
      console.log('  未跳转到 /g/list，等待 SPA 初始化后重试...');
      await sleep(5000);
    } else if (navRetry === 1) {
      console.log('  仍为跳转，尝试 JS click 兜底...');
      await evalJS(send, `(function(){
        var all=document.querySelectorAll('span,div,a,li,[class*="nav"],[class*="menu"]');
        for(var i=0;i<all.length;i++){
          if((all[i].textContent||'').trim()==='商品管理'){
            all[i].click(); break;
          }
        }
      })()`, 2);
      await sleep(5000);
    } else if (navRetry === 2) {
      console.log('  JS click 无效，重新 CDP 点击...');
      await clickAt(send, sidebarItem.rect.x, sidebarItem.rect.y);
      await sleep(5000);
    } else {
      console.log('  所有点击无效，尝试直接导航到 /g/list ...');
      await evalJS(send, `location.href = '/ffa/g/list'`, 2);
      await sleep(8000);
    }
    curURL = (await evalJS(send, 'location.href', 3, 5000)).value || '';
    console.log('  URL:', curURL.slice(0, 90));
  }

  // 关闭可能出现的弹窗
  await closePopups(send);
  await sleep(500);

  // ================================================================
  // [2/8] 点击「导出查询商品」
  // ================================================================
  console.log('\n[2/8] 点击「导出查询商品」');

  async function checkSidebarOpen() {
    const r = await findByText(send, '取消', { maxLenExtra: 1, minX: 1200, sel: 'button,span,div' });
    return !!(r.found && r.rect);
  }
  async function findExportBtn() {
    return waitForText(send, '导出查询商品', { maxLenExtra: 1, sel: 'button,a,[role="button"],span,div' }, 15000);
  }

  let exportBtn = await findExportBtn();
  if (!exportBtn.found || !exportBtn.rect) {
    throw new Error('NOT_FOUND: 导出查询商品');
  }
  console.log('  找到 @ (' + exportBtn.rect.x + ', ' + exportBtn.rect.y + ')');
  await clickAt(send, exportBtn.rect.x, exportBtn.rect.y);
  await sleep(3000);

  // 确认右侧边栏已打开（查找边栏中的「取消」按钮，一般在右侧 x > 1200）
  if (await checkSidebarOpen()) {
    console.log('  右侧边栏已打开 ✓');
  } else {
    // 可能弹窗挡住了第一次点击，关闭弹窗后重新定位并点击
    console.log('  右侧边栏未打开，关闭弹窗后重试点击...');
    await closePopups(send);
    await sleep(800);
    exportBtn = await findExportBtn();
    if (!exportBtn.found || !exportBtn.rect) throw new Error('NOT_FOUND: 导出查询商品');
    console.log('  重新定位 @ (' + exportBtn.rect.x + ', ' + exportBtn.rect.y + ')');
    await clickAt(send, exportBtn.rect.x, exportBtn.rect.y);
    await sleep(3000);
    if (await checkSidebarOpen()) {
      console.log('  右侧边栏已打开 ✓ (after retry)');
    } else {
      throw new Error('SIDEBAR_NOT_OPEN');
    }
  }
  await closePopups(send);
  await sleep(500);

  // ================================================================
  // [3/8] 点击右侧边栏底部的「导出」按钮（坐标无关兜底）
  // ================================================================
  console.log('\n[3/8] 点击右侧边栏「导出」按钮');
  const exportStartTime = new Date(); // 记录导出触发时间，避免下载到旧记录

  // 抽屉/弹层按钮的 getBoundingClientRect 可能因滚动或 transform 返回超出视口的坐标
  // （实测曾返回 x=2667,y=1029，远超 1920x1080 视口）→ CDP 坐标点击落空、导出未触发。
  // 故：能 scrollIntoView 进视口就用坐标点击，否则改用 DOM .click()（坐标无关）。
  async function scrollExportIntoView() {
    return evalJS(send, `(function(){
      var all=document.querySelectorAll('button,a,[role="button"]');
      for(var i=0;i<all.length;i++){
        var el=all[i]; var tt=(el.textContent||'').trim();
        if(tt==='导出'){
          var r=el.getBoundingClientRect();
          if(r.x>=1100 && r.width>0 && r.height>0){ try{ el.scrollIntoView({block:'center', inline:'center'}); }catch(e){} return 1; }
        }
      }
      return 0;
    })()`, 3);
  }
  async function jsClickExport() {
    return jsClick(send, '导出', {
      maxLenExtra: 1, minX: 1200, sel: 'button,a,[role="button"],[class*="btn"],[class*="Button"]'
    });
  }
  async function detectTriggerToast() {
    try {
      const r = await evalJS(send, `(function(){
        var s='';
        document.querySelectorAll('*[class*="toast"],*[class*="message"],*[class*="notify"],.arco-notification,.ecom-g-message').forEach(function(e){ s+=(e.innerText||'')+'\\n'; });
        var body=document.body?document.body.innerText:'';
        return /(导出任务|创建成功|提交成功|任务已创建|已开始导出|导出中|成功创建)/.test(s+body)?1:0;
      })()`, 3);
      return r && (r.value===1 || r.value==='1');
    } catch(e){ return false; }
  }

  let clickedOK = false;
  const tabsBeforeClick = new Set(
    (await httpGet('/json/list'))
      .filter(t => t.type === 'page' && t.url && !t.url.includes('chrome://'))
      .map(t => t.id)
  );
  // [重复导出修复 2026-08-13] 原实现：DOM click 已真实生效，但 toast 验证正则
  // 匹配不到实际文案 + 导出不弹新标签 → 误判"未触发"→ 循环内重复点击 + 循环后
  // 再点一次，实测生成 3 条导出记录。现改为：坐标点击后未检测到触发时只补一次
  // DOM click（坐标无关、必然生效）并立即信任；是否真的生成记录交由 [6/8] 导出
  // 记录页轮询（180s + NO_FRESH_RECORD + run-all 层重试）把关，杜绝一步内多次点击。
  const se = await findByText(send, '导出', { maxLenExtra: 1, minX: 1200, sel: 'button,a,[role="button"]' });
  if (se.found && se.rect) {
    console.log('  找到 @ (' + se.rect.x + ', ' + se.rect.y + ')');
    await scrollExportIntoView();
    await sleep(600);
    const se2 = await findByText(send, '导出', { maxLenExtra: 1, minX: 1200, sel: 'button,a,[role="button"]' });
    const inView = se2.found && se2.rect && se2.rect.x >= 0 && se2.rect.x <= 1920 && se2.rect.y >= 0 && se2.rect.y <= 1080;
    if (inView) {
      console.log('  视口内坐标 @ (' + se2.rect.x + ', ' + se2.rect.y + ') → CDP 点击');
      await clickAt(send, se2.rect.x, se2.rect.y);
      // 轻量验证（仅作快速确认，不作为重复点击依据）
      await sleep(3000);
      const targetsAfter = await httpGet('/json/list');
      const newTab = targetsAfter.some(t => t.type === 'page' && t.url && !t.url.includes('chrome://') && !tabsBeforeClick.has(t.id));
      const toastHit = await detectTriggerToast();
      if (newTab || toastHit) {
        clickedOK = true;
        console.log('  ✓ 导出已触发（' + (newTab ? '弹出标签页' : '任务提示') + '）');
      } else {
        // 坐标点击可能落空（历史 bug），补一次 DOM click（坐标无关）并信任
        console.log('  CDP 点击后未检测到触发 → DOM click 兜底（一次）');
        const j = await jsClickExport();
        console.log('  DOM click:', JSON.stringify(j));
        if (j.ok) clickedOK = true;
      }
    } else {
      console.log('  坐标超出视口（' + (se2.rect ? ('(' + se2.rect.x + ',' + se2.rect.y + ')') : 'none') + '）→ DOM click（坐标无关）');
      const j = await jsClickExport();
      console.log('  DOM click:', JSON.stringify(j));
      if (j.ok) { clickedOK = true; console.log('  ✓ DOM click 已执行（触发验证交由导出记录页 [6/8] 轮询）'); }
    }
  } else {
    console.log('  findByText 未命中 → DOM click...');
    const j = await jsClickExport();
    console.log('  DOM click:', JSON.stringify(j));
    if (j.ok) clickedOK = true;
  }
  if (!clickedOK) throw new Error('CANNOT_CLICK_SIDEBAR_EXPORT');

  // ================================================================
  // [4/8] 关闭自动弹出的新标签页
  // ================================================================
  console.log('\n[4/8] 等待弹出标签页并关闭...');
  const tabsBefore = new Set(
    (await httpGet('/json/list'))
      .filter(t => t.type === 'page' && t.url && !t.url.includes('chrome://'))
      .map(t => t.id)
  );
  // 等 ~3s 让弹窗出现
  await sleep(3500);
  const closedId = await closeNewPopupTab(tabsBefore, 15000);
  if (closedId) console.log('  弹窗标签页已关闭 ✓');
  await sleep(1000);

  // ================================================================
  // [5/8] 点击「查看导出记录」
  // ================================================================
  console.log('\n[5/8] 点击「查看导出记录」');
  await closePopups(send);
  await sleep(500);

  let recLink = await findByText(send, '查看导出记录', {
    maxLenExtra: 2, sel: 'button,a,[role="button"],span,div,[class*="link"]'
  });
  if (!recLink.found || !recLink.rect) {
    // 可能在 toast 通知中，扩大搜索范围
    recLink = await findByText(send, '导出记录', {
      maxLenExtra: 2, sel: 'button,a,[role="button"],span,div,[class*="link"],*'
    });
    if (!recLink.found || !recLink.rect) {
      // 二次搜索仍无可点击目标 → 最后尝试用 JS click 兜底（R3: 原为 && 属死代码）
      console.log('  尝试 JS click 查找...');
      const jcr = await jsClick(send, '查看导出记录', {
        maxLenExtra: 2, sel: 'button,a,[role="button"],span,div,[class*="link"],*'
      });
      if (jcr.ok) {
        console.log('  JS click ok:', JSON.stringify(jcr));
        await sleep(4000);
      } else {
        throw new Error('NOT_FOUND: 查看导出记录');
      }
    }
  }

  if (recLink.found && recLink.rect) {
    console.log('  找到 @ (' + recLink.rect.x + ', ' + recLink.rect.y + ') [' + recLink.txt + ']');
    await clickAt(send, recLink.rect.x, recLink.rect.y);
    await sleep(4000);
  }

  // 确认进入 /g/excel
  let finalURL = (await evalJS(send, 'location.href', 3, 5000)).value || '';
  console.log('  URL:', finalURL.slice(0, 90));
  if (!finalURL.includes('/g/excel')) {
    // 鼠标点击可能没触发导航，尝试 JS click
    console.log('  鼠标点击未导航，尝试 JS click...');
    const jcr = await jsClick(send, '查看导出记录', {
      maxLenExtra: 2, sel: 'button,a,[role="button"],span,div,[class*="link"],*'
    });
    if (jcr.ok) {
      await sleep(4000);
      finalURL = (await evalJS(send, 'location.href', 3, 5000)).value || '';
      console.log('  URL (after JS click):', finalURL.slice(0, 90));
    }
  }

  if (!finalURL.includes('/g/excel')) {
    // 尝试直接导航
    console.log('  尝试直接 Page.navigate...');
    await send('Page.navigate', { url: 'https://fxg.jinritemai.com/ffa/g/excel' }, 15000);
    await sleep(6000);
  }
  console.log('  已到达导出记录页 ✓');

  // ================================================================
  // [6/8] 找到刚导出的记录 → 获取下载链接及记录时间
  // ================================================================
  console.log('\n[6/8] 获取最新导出记录...');

  async function getTopRecord() {
    // 直接从表格行 <tr> 遍历，避免命中包裹元素导致行定位不一致
    const js = `(function(){
      var trs = document.querySelectorAll('tr.ecom-g-table-row, tr[data-row-key]');
      var results = [];
      for (var i = 0; i < trs.length; i++) {
        var tr = trs[i];
        var rt = tr.innerText || '';
        // 只处理含「下载报表」的行
        if (rt.indexOf('下载报表') < 0) continue;
        // 提取时间：优先完整格式 2026-07-17 16:04:33
        var rm = rt.match(/(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2}:\\d{2})/);
        var timeTxt = rm ? (rm[1] + ' ' + rm[2]) : '';
        // 兜底：仅到分的格式
        if (!timeTxt) {
          rm = rt.match(/(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2})/);
          timeTxt = rm ? (rm[1] + ' ' + rm[2]) : '';
        }
        // 在该行内找「下载报表」可点击元素
        var links = tr.querySelectorAll('a,span,div');
        var found = null;
        for (var j = 0; j < links.length; j++) {
          var l = links[j];
          var lt = (l.textContent || '').trim();
          if (lt === '下载报表' || (lt.indexOf('下载') >= 0 && lt.indexOf('报表') >= 0 && lt.length <= 12)) {
            var r = l.getBoundingClientRect();
            if (r.width > 10 && r.height > 5 && r.x > 50) {
              var href = '';
              if (l.tagName === 'A') href = l.getAttribute('href') || '';
              found = {
                x: Math.round(r.x + r.width / 2),
                y: Math.round(r.y + r.height / 2),
                time: timeTxt,
                href: href
              };
              break;
            }
          }
        }
        if (found) results.push(found);
      }
      return JSON.stringify(results.slice(0, 8));
    })()`;
    const r = await evalJS(send, js, 6, 12000);
    try { return JSON.parse(r.value || '[]'); } catch (e) { return []; }
  }

  let topRec = null;
  const pollStart = Date.now();
  let lastRefresh = 0;
  while (Date.now() - pollStart < 180000) {
    const records = await getTopRecord();
    if (records.length > 0) {
      const top = records[0];
      const rt = parseRecordTime(top.time);
      const ageSec = rt ? ((Date.now() - rt.getTime()) / 1000) : 999999;
      const TIME_TOLERANCE_MS = 90000; // 90s 容忍时钟偏差 / 弹窗提前创建记录
      const isNewerThanExport = rt && rt.getTime() > (exportStartTime.getTime() - TIME_TOLERANCE_MS);
      console.log('  top record: "' + top.time + '" (' + Math.round(ageSec) + 's ago) @ (' + top.x + ',' + top.y + ')' + (isNewerThanExport ? ' ✓ 新记录' : ' ✗ 旧记录'));
      if (isNewerThanExport) {
        topRec = top;
        break;
      }
      console.log('  记录太旧，等待新记录...');
    } else {
      console.log('  暂无下载记录，等待...');
    }
    // 每 60s 才刷新一次页面（原 30s，刷新是全页重载、代价高；放宽间隔可省大量无效刷新）
    // 导出后端生成记录通常 30~120s，轮询本身即可在记录出现后立即命中
    if (Date.now() - lastRefresh > 60000) {
      try {
        await send('Page.reload', { ignoreCache: false }, 15000);
        console.log('  已刷新页面...');
        await sleep(3000);
      } catch(e) {}
      lastRefresh = Date.now();
    }
    await sleep(3000);
  }
  if (!topRec) throw new Error('NO_FRESH_RECORD');

  // ================================================================
  // [7/8] 下载文件
  // ================================================================
  console.log('\n[7/8] 下载文件...');

  let dlPath;
  if (topRec.href) {
    console.log('  直接下载 URL:', topRec.href.slice(0, 100));
    dlPath = await downloadFile(send, topRec.href, DL_DIR);
  } else {
    // 无 href → 监听 CDP Network 事件截获下载 URL，直接 Node.js 下载
    console.log('  无直接 URL，通过 Network 拦截下载地址...');

    // 注册临时 Network 事件监听
    let dlURL = '';
    let dlDone = false;
    const onNetEvent = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Network.responseReceived') {
          const url = msg.params.response.url;
          const ct = (msg.params.response.headers || {})['content-type'] || '';
          const cd = (msg.params.response.headers || {})['content-disposition'] || '';
          if (url.includes('downloadTaskResult') || url.includes('/tproduct/download') ||
              ct.includes('octet-stream') || ct.includes('excel') || ct.includes('spreadsheet') ||
              cd.includes('attachment') || cd.includes('.xlsx') || cd.includes('.xls')) {
            dlURL = url;
            console.log('  截获下载 URL:', dlURL.slice(0, 100));
            dlDone = true;
          }
        }
      } catch (e) {}
    };
    ws.addEventListener('message', onNetEvent);

    // JS click 触发下载（React 事件处理器需要真实的合成事件）
    const jcr = await jsClick(send, '下载报表', {
      maxLenExtra: 2, sel: 'a,[class*="index_operate"]',
      minX: 1800
    });
    console.log('  Click result:', JSON.stringify(jcr));

    // 等待 Network 事件或超时
    const startWait = Date.now();
    while (!dlDone && Date.now() - startWait < 15000) {
      await sleep(300);
    }
    ws.removeEventListener('message', onNetEvent);

    if (dlURL) {
      // 用 Node.js HTTP 直接下载（带 Cookie）
      dlPath = await downloadFile(send, dlURL, DL_DIR);
    } else {
      // 兜底：文件系统监控
      console.log('  未截获下载 URL，回退到文件监控...');
      const defDL = path.join(process.env.USERPROFILE || '', 'Downloads');
      const dirs = [{ dir: DL_DIR }, { dir: defDL }];
      const before = {};
      for (const d of dirs) {
        if (fs.existsSync(d.dir)) {
          before[d.dir] = {};
          const files = fs.readdirSync(d.dir);
          for (const f of files) {
            try { before[d.dir][f] = fs.statSync(path.join(d.dir, f)).size; } catch (e) { before[d.dir][f] = -1; }
          }
        }
      }
      const fsStart = Date.now();
      while (Date.now() - fsStart < 90000) {
        for (const d of dirs) {
          if (!fs.existsSync(d.dir)) continue;
          const cur = fs.readdirSync(d.dir);
          for (const f of cur) {
            if (!/\.(xlsx|xls|csv|zip)$/i.test(f)) continue;
            const fp = path.join(d.dir, f);
            let sz = 0;
            try { sz = fs.statSync(fp).size; } catch (e) { continue; }
            const prev = (before[d.dir] || {})[f];
            const isNew = (prev === undefined) || (prev >= 0 && Math.abs(sz - prev) > 50);
            if (isNew && sz > 100) {
              for (let s = 0; s < 8; s++) {
                let sz2 = -1;
                try { sz2 = fs.statSync(fp).size; } catch (e) {}
                if (sz2 === sz && sz2 > 100) { dlPath = fp; break; }
                sz = sz2;
                await sleep(500);
              }
              break;
            }
          }
          if (dlPath) break;
        }
        if (dlPath) break;
        await sleep(1000);
      }
    }
  }

  if (!dlPath || !fs.existsSync(dlPath)) throw new Error('DOWNLOAD_FAILED：未能获取下载文件');
  console.log('  下载完成:', dlPath);

  // ================================================================
  // [8/8] 归档：取导出记录时间 - 1 天作为文件夹/文件名日期
  // ================================================================
  console.log('\n[8/8] 归档文件...');

  // 解析导出记录中的时间作为"数据日期"
  const recordTime = parseRecordTime(topRec.time);
  if (!recordTime) throw new Error('CANNOT_PARSE_RECORD_TIME: ' + topRec.time);
  console.log('  导出记录时间:', recordTime.toISOString());

  // 数据日期 = 导出记录时间 - 1 天
  const dataDate = new Date(recordTime);
  dataDate.setDate(dataDate.getDate() - 1);
  const dateStr = dataDate.toISOString().slice(0, 10); // YYYY-MM-DD
  console.log('  数据日期（前一天）:', dateStr);

  const destFolder = path.join(PROJECT_DIR, dateStr);
  if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

  const ext = path.extname(dlPath) || '.xlsx';
  const finalName = dateStr + '_' + BRAND + '_商品管理导出' + ext;
  const destPath = path.join(destFolder, finalName);

  fs.copyFileSync(dlPath, destPath);
  console.log('  归档至:', destPath);
  console.log('  文件大小:', (fs.statSync(destPath).size / 1024).toFixed(1), 'KB');

  // 清理临时下载
  try { if (dlPath.startsWith(DL_DIR)) fs.unlinkSync(dlPath); } catch (e) {}

  // 导航回首页（供后续步骤使用）
  console.log('  导航回首页...');
  try { await send('Page.navigate', { url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' }, 15000); } catch (e) {}
  await sleep(5000);

  // 收尾：确保仅保留抖店标签页
  await ensureOnlyDouDianTab();

  console.log('\n✅ STEP4 完成！');
  ws.close();
  process.exit(0);
}

main().catch(async e => {
  console.error('FATAL:', e && e.message);
  try { await require('./fail-capture.cjs').captureOnFail('step4-' + (process.env.DOUDIAN_BRAND || ''), e && e.message); } catch (_) {}
  process.exit(1);
});
