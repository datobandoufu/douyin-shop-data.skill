// step7-switch-shop.cjs — 第七步：切换店铺（→ 目标店铺 DD_SHOP_B）
// ====================================================================
// 复用 brand-helper.cjs 的 ensureBrand：
//   - 修复后的店铺匹配（不再要求 children.length===0）
//   - 切换后校验当前品牌 + 重试，确认真正切换成功
//   - 明确目标 = BRANDS[1]（DD_SHOP_B），不再依赖"另一个"相对逻辑
// ====================================================================

const WebSocket = global.WebSocket;
const http = require('http');
const { ensureBrand, getCurrentBrand, BRANDS, bringToFront } = require('./brand-helper.cjs');

const PORT = 9222;
const CDP_BASE = 'http://localhost:' + PORT;

function httpGet(p) { return new Promise((res, rej) => { http.get(CDP_BASE + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej).setTimeout(2000, () => rej(new Error('T'))); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 把指定 target 提到前台，并关闭其它 fxg 标签页（仅保留 keepId 这一张）
async function focusAndKeepOnly(keepId) {
  try {
    const ver = await httpGet('/json/version');
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r, rej) => {
      ws.addEventListener('open', () => {
        let n = 0;
        ws.send(JSON.stringify({ id: ++n, method: 'Target.activateTarget', params: { targetId: keepId } }));
        setTimeout(() => r(), 1200);
      }, { once: true });
      ws.addEventListener('error', () => r());
    });
    try { ws.close(); } catch (e) {}
  } catch (e) {}

  // 关闭其它 fxg 标签页，避免罗盘等残留标签抢占前台
  try {
    const targets = await httpGet('/json/list');
    const otherFxg = targets.filter(t => t.type === 'page' && t.id !== keepId &&
      t.url && t.url.includes('fxg.jinritemai.com'));
    if (otherFxg.length) {
      const ver = await httpGet('/json/version');
      const ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise((r, rej) => {
        ws.addEventListener('open', () => {
          let n = 0;
          for (const t of otherFxg) ws.send(JSON.stringify({ id: ++n, method: 'Target.closeTarget', params: { targetId: t.id } }));
          setTimeout(() => r(), 1200);
        }, { once: true });
        ws.addEventListener('error', () => r());
      });
      try { ws.close(); } catch (e) {}
      console.log('  已关闭 ' + otherFxg.length + ' 个其它 fxg 标签');
    }
  } catch (e) {}
}

function connectToTarget(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  function send(method, params = {}, timeoutMs = 15000) {
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); rej(new Error('T:' + method)); } }, timeoutMs);
      pending.set(msgId, { res, rej });
    });
  }
  ws.addEventListener('message', ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const pr = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) pr.rej(new Error(JSON.stringify(msg.error))); else pr.res(msg.result);
    }
  });
  return new Promise((r, rej) => {
    ws.addEventListener('open', async () => {
      await Promise.allSettled([send('Page.enable', {}, 5000), send('Runtime.enable', {}, 5000)]);
      r({ ws, send, close: () => { try { ws.close(); } catch (e) {} } });
    }, { once: true });
    ws.addEventListener('error', rej);
  });
}

async function closeNonFxgTabs() {
  try {
    const targets = await httpGet('/json/list');
    const others = targets.filter(t => t.type === 'page' && t.url && !t.url.includes('chrome://') && !t.url.includes('fxg.jinritemai.com'));
    if (others.length === 0) return;
    const ver = await httpGet('/json/version');
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r) => {
      ws.addEventListener('open', () => {
        let n = 0;
        for (const t of others) ws.send(JSON.stringify({ id: ++n, method: 'Target.closeTarget', params: { targetId: t.id } }));
        setTimeout(() => { try { ws.close(); } catch (e) {} r(); }, 1500);
      }, { once: true });
      ws.addEventListener('error', () => r());
    });
  } catch (e) {}
}

async function main() {
  console.log('=== 第七步：切换店铺（→ ' + (BRANDS[1] || '店铺B') + '）===\n');

  const targets0 = await httpGet('/json/list');
  const fxg = targets0.find(t => t.type === 'page' && t.url && t.url.includes('fxg.jinritemai.com'));
  if (!fxg) { console.error('✗ 未找到 fxg 基准页'); process.exit(1); }
  console.log('[1] fxg:', fxg.url.slice(0, 60));

  const c = await connectToTarget(fxg.webSocketDebuggerUrl);
  await sleep(2000);

  // 关键：把主页标签提到前台并关掉其它 fxg 标签，否则 Input 事件会被前台标签节流挂起
  await focusAndKeepOnly(fxg.id);
  await bringToFront(c.send);
  await sleep(3000);

  // 校验页面存活
  try {
    const alive = await c.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 8000);
    if (!alive || alive.result.value !== 2) throw new Error('page not alive');
  } catch (e) {
    console.error('✗ 主页标签无响应: ' + e.message);
    c.close(); process.exit(1);
  }
  console.log('[1b] 主页标签已聚焦并存活');

  // 支持 --shop="店名" 指定目标，默认 BRANDS[1]（DD_SHOP_B）保持 run-all 兼容
  const shopArg = process.argv.find(a => a.startsWith('--shop='));
  const TARGET = shopArg ? shopArg.slice(7).replace(/^["']|["']$/g, '') : BRANDS[1];
  const cur = await getCurrentBrand(c.send);
  console.log('[2] 切换前品牌:', cur || '(空)');

  const ok = await ensureBrand(c.send, TARGET, { maxTry: 2 });
  if (!ok) {
    console.error('  ✗ 切换失败，当前仍为: ' + (await getCurrentBrand(c.send) || '(空)'));
    try { await require('./fail-capture.cjs').captureOnFail('step7-switch', 'ensureBrand 返回 false'); } catch (_) {}
    c.close();
    process.exit(1);
  }
  const finalBrand = await getCurrentBrand(c.send);
  console.log('\n✅ 切换成功: ' + (cur || '(空)') + ' → ' + finalBrand);

  console.log('\n关闭非 fxg 标签...');
  await closeNonFxgTabs();

  c.close();
  process.exit(0);
}

main().catch(async e => {
  console.error('FATAL:', e && e.message);
  try { await require('./fail-capture.cjs').captureOnFail('step7-switch', e && e.message); } catch (_) {}
  process.exit(1);
});
