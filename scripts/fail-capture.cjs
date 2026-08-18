// fail-capture.cjs — 致命失败自动诊断（R7）
// ====================================================================
// captureOnFail(stepName, [errMsg]) —— 在任一步骤致命失败时调用：
//   - 枚举所有打开的抖店相关页面（fxg / compass / buyin）
//   - 逐页截图保存到 logs/<date>_<step>_<idx>.png
//   - 记录 URL + 视口尺寸 + 错误信息到 logs/<date>_<step>_diag.json
//   - 全程吞异常，绝不 throw（诊断失败不能影响主流程退出）
// ====================================================================

const WebSocket = global.WebSocket;
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const CDP_BASE = 'http://localhost:' + PORT;
const LOGS_DIR = path.join(__dirname, 'logs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function httpGet(p) {
  return new Promise((res, rej) => {
    http.get(CDP_BASE + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); })
      .on('error', rej).setTimeout(2500, function () { this.destroy(); rej(new Error('T')); });
  });
}

// 单页：连接 → 截图 + 取视口尺寸
function captureOnePage(wsUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return finish(null); }
    let id = 0; const pending = new Map();
    const send = (method, params = {}, ms = 8000) => {
      const mid = ++id;
      try { ws.send(JSON.stringify({ id: mid, method, params })); } catch (e) { return Promise.reject(e); }
      return new Promise((res, rej) => {
        const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('T:' + method)); } }, ms);
        pending.set(mid, { res, rej, t });
      });
    };
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending.has(m.id)) { const pr = pending.get(m.id); pending.delete(m.id); clearTimeout(pr.t); m.error ? pr.rej(new Error(JSON.stringify(m.error))) : pr.res(m.result); }
    });
    ws.addEventListener('error', () => finish(null));
    ws.addEventListener('open', async () => {
      try {
        await send('Page.enable', {}, 5000).catch(() => {});
        let dims = null;
        try {
          const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,url:location.href})', returnByValue: true }, 6000);
          dims = JSON.parse(r.result.value);
        } catch (e) {}
        let png = null;
        try { const shot = await send('Page.captureScreenshot', { format: 'png' }, 8000); png = shot.data; } catch (e) {}
        try { ws.close(); } catch (e) {}
        finish({ dims, png });
      } catch (e) { try { ws.close(); } catch (_) {} finish(null); }
    }, { once: true });
    setTimeout(() => finish(null), 12000); // 硬超时
  });
}

async function captureOnFail(stepName, errMsg) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const stamp = nowStamp();
    const safeStep = String(stepName || 'step').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    let targets = [];
    try { targets = await httpGet('/json/list'); } catch (e) {}
    const pages = (targets || []).filter(t => t.type === 'page' && t.url &&
      (t.url.includes('jinritemai.com') || t.url.includes('compass') || t.url.includes('buyin')));

    const diag = { step: stepName, error: errMsg || null, time: stamp, pages: [] };
    let idx = 0;
    for (const t of pages) {
      idx++;
      const cap = await captureOnePage(t.webSocketDebuggerUrl);
      const rec = { url: t.url, viewport: cap && cap.dims ? cap.dims : null, screenshot: null };
      if (cap && cap.png) {
        const fn = `${stamp}_${safeStep}_${idx}.png`;
        try { fs.writeFileSync(path.join(LOGS_DIR, fn), Buffer.from(cap.png, 'base64')); rec.screenshot = 'logs/' + fn; } catch (e) {}
      }
      diag.pages.push(rec);
      await sleep(200);
    }
    const diagFn = `${stamp}_${safeStep}_diag.json`;
    try { fs.writeFileSync(path.join(LOGS_DIR, diagFn), JSON.stringify(diag, null, 2)); } catch (e) {}
    console.error(`  🩺 已保存失败诊断: logs/${diagFn}（${diag.pages.filter(p => p.screenshot).length} 张截图）`);
  } catch (e) {
    // 诊断本身失败：静默，不影响主流程
    try { console.error('  ⚠ 失败诊断采集异常: ' + (e && e.message)); } catch (_) {}
  }
}

module.exports = { captureOnFail };
