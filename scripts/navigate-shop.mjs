import WebSocket from 'ws';

async function main() {
  const ver = await fetch('http://localhost:9222/json/version').then(r => r.json());
  const browserWs = ver.webSocketDebuggerUrl;
  const browser = new WebSocket(browserWs);
  await new Promise(res => browser.on('open', res));

  let msgId = 0;
  const pending = new Map();
  function send(method, params = {}, sessionId = null) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  browser.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });

  // 在浏览器中新建一个标签页并直接打开抖店后台
  const url = 'https://fxg.jinritemai.com/';
  const { targetId } = await send('Target.createTarget', { url });
  console.log('[+] 已新建标签页 targetId=', targetId);

  // 等待页面加载
  await new Promise(r => setTimeout(r, 5000));

  // 附加到该标签页会话，读取当前 URL / title 确认已进入抖店
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const info = await send('Page.getNavigationHistory', {}, sessionId);
  const cur = info.entries[info.currentIndex];
  console.log('[+] 当前页面 URL =', cur.url);
  const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
  console.log('[+] 当前页面 title =', title.result.value);

  const ok = cur.url.includes('fxg.jinritemai.com');
  console.log(ok ? '[OK] 已进入抖店后台' : '[WARN] 未确认进入抖店，请检查登录态');

  browser.close();
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
