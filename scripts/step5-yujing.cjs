// step5-yujing.cjs — 第五步：精选联盟→看数据→精确hover读tooltip→Excel
// ====================================================================
// 核心策略：
//   1. 精确扫描 canvas 找到蓝色线 (25,102,255) 的 y 坐标
//   2. 鼠标精确移动到每个数据点的 (x, y) 位置
//   3. before/after 对比捕获新出现的 DOM tooltip 元素
//   4. 每步之间检测弹窗并处理（不盲目重开页面）
// ====================================================================

const WebSocket = global.WebSocket;
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 9222;
const CDP_BASE = 'http://localhost:' + PORT;
const PROJECT_DIR = path.join(__dirname, '..');
const BRAND = process.env.DOUDIAN_BRAND || process.env.DD_SHOP_A || '店铺A';
const PYTHON = process.env.DD_PYTHON || 'python';
const XLSX_PACK = path.join(__dirname, '..', 'lib', 'xlsx_pack.py');
const XLSX_TPL = path.join(__dirname, '..', 'lib', 'minimal_xlsx');

// 蓝色线颜色
const LINE_COLOR = { r: 25, g: 102, b: 255 };

function httpGet(p) { return new Promise((res, rej) => { http.get(CDP_BASE + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej).setTimeout(2000, () => rej(new Error('T'))); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =================== CDP 连接 ===================

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
      await Promise.allSettled([send('Page.enable', {}, 5000), send('Runtime.enable', {}, 5000), send('Emulation.enable', {}, 5000)]);
      // [M1] 锁定视口 1920x1080 / DPR=1，消除坐标漂移（即使复用已运行 Chrome 也生效）
      try { await send('Emulation.setDeviceMetricsOverride', { deviceScaleFactor: 1, width: 1920, height: 1080, mobile: false }, 8000); } catch (e) {}
      r({ ws, send, close: () => { try { ws.close(); } catch(e){} } });
    }, { once: true });
    ws.addEventListener('error', rej);
  });
}

async function evalJS(send, expr, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, timeout: 10000 }, 13000); return r.result; }
    catch (e) { if (i < retries - 1) await sleep(1000); else throw e; }
  }
}

async function clickAt(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function mouseMove(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

// =================== 按文本定位顶部导航（M4：替代硬编码坐标，店间不再漂移） ===================
async function findNavByText(send, text, opts = {}) {
  const yMax = opts.yMax || 300;
  const maxLen = opts.maxLen || (text.length + 4);
  const js = `(function(){
    var TXT=${JSON.stringify(text)}, YMAX=${yMax}, MAXLEN=${maxLen};
    var all=document.querySelectorAll('a,span,div,li,button,[role="tab"],[class*="tab"],[class*="menu"],[class*="nav"]');
    var cands=[];
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      if(!t) continue;
      var hit=(t===TXT)||(t.indexOf(TXT)>=0&&t.length<=MAXLEN);
      if(!hit) continue;
      var r=e.getBoundingClientRect();
      if(r.width<10||r.height<8) continue;
      if(r.y>YMAX||r.y<0) continue;
      var cs=window.getComputedStyle(e);
      if(cs.display==='none'||cs.visibility==='hidden') continue;
      cands.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
        exact:(t===TXT)?1:0, leaf:(e.children.length===0)?1:0, len:t.length, top:r.y, left:r.x});
    }
    cands.sort(function(a,b){ return (b.exact-a.exact)||(b.leaf-a.leaf)||(a.len-b.len)||(a.top-b.top)||(a.left-b.left); });
    return JSON.stringify(cands[0]||{nf:1});
  })()`;
  try {
    const pos = JSON.parse(((await evalJS(send, js, 3)) || {}).value || '{}');
    if (pos && pos.x) return { x: pos.x, y: pos.y };
  } catch (e) {}
  return null;
}

// =================== 弹窗处理 ===================

async function closePopups(wsConn) {
  let closed = 0;
  for (let round = 0; round < 5; round++) {
    // Escape
    for (let i = 0; i < 2; i++) {
      try { await wsConn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
      try { await wsConn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
      await sleep(200);
    }
    // 找"我知道了"/"知道了"按钮
    const btnsJS = `(function(){
      var all=document.querySelectorAll('button,span,div');
      var out=[];
      for(var i=0;i<all.length;i++){
        var el=all[i]; var t=(el.textContent||'').trim();
        if((t==='我知道了'||t==='知道了')&&el.children.length===0){
          var r=el.getBoundingClientRect();
          var v=window.getComputedStyle(el).visibility;
          var d=window.getComputedStyle(el).display;
          if(r.width>10&&r.height>8&&r.x>0&&r.y>0&&v!=='hidden'&&d!=='none'){
            out.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
          }
        }
      }
      return JSON.stringify(out);
    })()`;
    const buttons = JSON.parse(((await evalJS(wsConn.send, btnsJS, 2))||{}).value || '[]');
    if (buttons.length === 0) break;
    for (const b of buttons) {
      await clickAt(wsConn.send, b.x, b.y);
      await sleep(600);
      closed++;
    }
    await sleep(1000);
  }
  if (closed > 0) console.log('  关闭 ' + closed + ' 个弹窗');
  return closed;
}

// =================== 强力清屏（首页蒙层/遮罩检测 + 点关闭） ===================

async function forceClearFxgPage(fxgConn) {
  console.log('  强力清屏...');
  // [风控优化 2026-08-13] 轮次 5→3、Escape/点击间加随机抖动，降低机械连发特征
  const rnd = (min, max) => min + Math.floor(Math.random() * (max - min));
  for (let round = 0; round < 3; round++) {
    // 1. Escape（每次按键后随机停顿，模拟真人节奏）
    for (let i = 0; i < 2; i++) {
      try { await fxgConn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
      try { await fxgConn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
      await sleep(rnd(150, 400));
    }

    // 2. 轻量扫描：只查 button 关闭按钮，只查 class 含 modal/dialog 的蒙层元素
    const scanJS = `(function(){
      var out={closeBtns:[], hasNav:false, maskCount:0};

      var navItems=document.querySelectorAll('.index_menuItem__1DJRt,[class*="menuItem"],[class*="nav-menu"]');
      for(var i=0;i<navItems.length;i++){
        var r=navItems[i].getBoundingClientRect();
        if(r.y<80&&r.width>40&&window.getComputedStyle(navItems[i]).visibility!=='hidden'){out.hasNav=true;break;}
      }

      var btns=document.querySelectorAll('button');
      for(var i=0;i<btns.length&&i<50;i++){
        var e=btns[i],t=(e.textContent||'').trim(),r=e.getBoundingClientRect();
        if((t==='×'||t==='X'||t==='关闭'||t==='知道了'||t==='我知道了')&&r.width>8&&r.height>8&&r.x>10){
          if(window.getComputedStyle(e).display!=='none') out.closeBtns.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t});
        }
      }

      var modals=document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="overlay"],[class*="popup"]');
      for(var j=0;j<modals.length&&j<20;j++){
        var m=modals[j],mr=m.getBoundingClientRect(),cs=window.getComputedStyle(m);
        if(cs.display!=='none'&&cs.visibility!=='hidden'&&mr.width>200&&mr.height>200) out.maskCount++;
      }
      return JSON.stringify(out);
    })()`;
    let scan = JSON.parse(((await evalJS(fxgConn.send, scanJS, 2))||{}).value || '{}');

    if (scan.closeBtns && scan.closeBtns.length > 0) {
      for (const b of scan.closeBtns) {
        console.log('  点击关闭: ' + b.text + ' @(' + b.x + ',' + b.y + ')');
        await clickAt(fxgConn.send, b.x, b.y);
        await sleep(rnd(300, 700));
      }
    }

    if (scan.maskCount > 0 && (!scan.closeBtns || scan.closeBtns.length === 0)) {
      console.log('  检测到 ' + scan.maskCount + ' 个弹窗层，等待动画...');
      await sleep(rnd(600, 1200));
    }

    if (scan.maskCount === 0 && (!scan.closeBtns || scan.closeBtns.length === 0) && scan.hasNav) break;

    await sleep(rnd(300, 700));
  }

  const navOk = ((await evalJS(fxgConn.send, `!!document.querySelector('.index_menuItem__1DJRt,[class*="menuItem"]')`, 2))||{}).value;
  if (!navOk) {
    console.log('  ⚠ 导航仍不可见，刷新页面兜底...');
    try { await fxgConn.send('Page.reload', { ignoreCache: false }, 15000); } catch(e) {}
    await sleep(10000);
    for (let i = 0; i < 3; i++) {
      try { await fxgConn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch(e) {}
      try { await fxgConn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch(e) {}
      await sleep(rnd(250, 500));
    }
    await closePopups(fxgConn);
  }
  console.log('  清屏完成');
}

// =================== Canvas 扫描 ===================

async function scanBlueLine(send) {
  // 扫描佣金趋势线：优先抖音蓝，兜底任意高饱和色（防抖店改配色）；
  // 图表空态（暂无数据）优雅返回 {empty:true} 哨兵而非抛错
  const scanJS = `(function(){
    var c=document.querySelector('canvas');
    if(!c) return JSON.stringify({err:'no canvas'});
    var r=c.getBoundingClientRect();
    var w=Math.round(r.width),h=Math.round(r.height);
    if(w<800) return JSON.stringify({err:'canvas too small',w:w});
    var ctx=c.getContext('2d');
    var img=ctx.getImageData(0,0,w,h);
    var d=img.data;
    function isLine(r2,g2,b2,a2){
      if(a2<=120) return false;
      // 优先：抖音蓝 (r<60, 80<=g<=130, b>=240)
      if(r2<60 && g2>=80 && g2<=130 && b2>=240) return true;
      // 兜底：任意高饱和非白非灰（数据线通常是彩色；网格线/坐标字为低饱和灰/黑）
      var maxc=Math.max(r2,g2,b2), minc=Math.min(r2,g2,b2);
      if(maxc>120 && (maxc-minc)>60 && !(r2>240&&g2>240&&b2>240)) return true;
      return false;
    }
    var xMin=null,xMax=null;
    for(var x=5;x<w-5;x+=20){
      for(var y=0;y<h;y++){
        var idx=(y*w+x)*4;
        if(isLine(d[idx],d[idx+1],d[idx+2],d[idx+3])){if(xMin==null||x<xMin)xMin=x;if(xMax==null||x>xMax)xMax=x;break;}
      }
    }
    // 空态检测：页面含"暂无数据/暂无内容/没有数据"文案
    var body=(document.body.innerText||'').replace(/\\s/g,'');
    var noData=/暂无数据|暂无内容|没有数据|暂无/.test(body);
    if(xMin==null||xMax==null){
      return JSON.stringify({err:'no line found',empty:noData});
    }
    // 折线绘制动画未完成时只画出前半段 → 采样点会错位/漏掉最后几天。
    // 正常 7 天折线横跨画布约 83% 宽度，低于 75% 判定为"未画完"，交由上层重试。
    if((xMax-xMin) < w*0.75){
      return JSON.stringify({err:'line partial ('+xMin+'-'+xMax+' / w='+w+')'});
    }
    var step=(xMax-xMin)/6;
    var out={w:w,h:h,xMin:xMin,xMax:xMax};
    for(var xi=0;xi<7;xi++){
      var x=Math.round(xMin+xi*step);
      var bestY=null,bestA=0;
      for(var y=0;y<h;y++){
        var idx2=(y*w+x)*4;
        if(isLine(d[idx2],d[idx2+1],d[idx2+2],d[idx2+3]) && d[idx2+3]>bestA){bestA=d[idx2+3];bestY=y;}
      }
      out['y'+xi]=bestY;
      out['x'+xi]=x;
    }
    return JSON.stringify(out);
  })()`;

  // 内部重试：图表未渲染完导致的 no line found 多为瞬态，重试 4 次（每次等 3s）
  const tries = 4;
  for (let t = 0; t < tries; t++) {
    const result = await evalJS(send, scanJS, 5);
    const scan = JSON.parse(result?.value || '{}');
    if (scan.err) {
      if (scan.err === 'no line found' && scan.empty) {
        console.log('  扫描: 图表为空态（暂无数据），返回 empty 哨兵');
        return { empty: true };
      }
      if (t < tries - 1) {
        console.log('  ⚠️ 扫描第' + (t + 1) + '次: ' + scan.err + '，3s 后重试...');
        // [风控优化 2026-08-13] 随机抖动替代固定 3s，避免等间隔重试的机械特征
        await sleep(2500 + Math.floor(Math.random() * 1500));
        continue;
      }
      throw new Error('Canvas scan error: ' + scan.err);
    }
    const ys = [], xs = [];
    for (let i = 0; i < 7; i++) { ys.push(scan['y' + i]); xs.push(scan['x' + i]); }
    console.log('  线范围: x=[' + scan.xMin + ',' + scan.xMax + ']');
    return { ys, xs, w: scan.w, h: scan.h };
  }
}

// =================== Tooltip 提取（before/after + 容器级别） ===================

async function getTextSnapshot(send, canvasScreenX, canvasScreenY) {
  const js = `(function(cx,cy){
    var all=document.querySelectorAll('div,span,p');
    var texts=[];
    for(var i=0;i<all.length;i++){
      var el=all[i];
      var t=(el.textContent||'').trim(); if(t.length<3||t.length>300) continue;
      var r=el.getBoundingClientRect(); if(r.width<10||r.height<8) continue;
      var v=window.getComputedStyle(el).visibility;
      if(v==='hidden') continue;
      if(r.x<cx-30||r.x>cx+1650) continue;
      if(r.y<cy-150||r.y>cy+300) continue;
      // 保留容器和叶子级别
      texts.push({t:t, w:Math.round(r.width), h:Math.round(r.height), x:Math.round(r.x), y:Math.round(r.y), leaf:el.children.length===0});
    }
    return JSON.stringify(texts);
  })(${canvasScreenX},${canvasScreenY})`;
  const r = await evalJS(send, js, 3);
  try { return JSON.parse(r?.value || '[]'); } catch(e) { return []; }
}

function diffSnapshots(before, after) {
  // 返回前文本哈希
  const bSet = new Set(before.map(e => e.t));
  const newItems = after.filter(e => !bSet.has(e.t));
  // 按大小排序（tooltip 通常是 mid-size 的 box）
  newItems.sort((a,b) => (b.w * b.h) - (a.w * a.h));
  return newItems;
}

// =================== 标签页管理 ===================

async function closeAllNonFxgTabs() {
  try {
    const targets = await httpGet('/json/list');
    const nonFxg = targets.filter(t => t.type === 'page' && t.url && !t.url.includes('chrome://') && !t.url.includes('fxg.jinritemai.com'));
    if (nonFxg.length === 0) return;
    const version = await httpGet('/json/version');
    if (!version || !version.webSocketDebuggerUrl) return;
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, rej) => {
      ws.addEventListener('open', () => {
        let n = 0;
        for (const t of nonFxg) ws.send(JSON.stringify({ id: ++n, method: 'Target.closeTarget', params: { targetId: t.id } }));
        setTimeout(() => { try { ws.close(); } catch (e) {} r(); }, 1500);
      }, { once: true });
      ws.addEventListener('error', () => r());
    });
  } catch (e) {}
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d); else fs.copyFileSync(s, d);
  }
}

// =================== 主流程 ===================

async function main() {
  console.log('=== 第五步：精选联盟→看数据→精确hover读tooltip→Excel ===\n');

  // [修复 2026-07-28] 开场先清掉上次失败残留的 buyin/douyinec 标签，
  // 否则点击"精选联盟"会复用旧标签而不弹新标签 → 误判 NO_BUYIN_TAB
  await closeAllNonFxgTabs();
  await sleep(1500);

  // [1] 找 fxg 基准 tab
  let targets = await httpGet('/json/list');
  let fxg = targets.find(t => t.type === 'page' && t.url && t.url.includes('fxg.jinritemai.com'));
  if (!fxg) { console.error('✗ 未找到 fxg 基准页'); process.exit(1); }
  console.log('[1/9] fxg tab: ' + fxg.url.slice(0, 70));
  const fxgTabsBefore = new Set(targets.map(t => t.id));

  // [2] 点击顶部"精选联盟"（先强力清屏确保点击不会被弹窗拦截）
  console.log('\n[2/9] 强力清屏 → 点击"精选联盟"...');
  const fxgConn = await connectToTarget(fxg.webSocketDebuggerUrl);

  // [0] 品牌校验（防污染）：确保当前店铺 == BRAND，否则先切换
  const { ensureBrand } = require('./brand-helper.cjs');
  console.log('\n[0] 品牌校验（防污染）...');
  const brandOk = await ensureBrand(fxgConn.send, BRAND);
  if (!brandOk) {
    console.error('  ✗ 品牌校验失败，终止本步以防数据污染（当前非 ' + BRAND + '）');
    fxgConn.close();
    process.exit(1);
  }
  console.log('  ✓ 品牌校验通过：' + BRAND);

  await forceClearFxgPage(fxgConn);

  // [M4] 点击顶部"精选联盟"改用 findNavByText（文本定位 + 区域过滤），消除店间坐标漂移
  // [修复 2026-07-28] 抖店顶部"精选联盟"已改为 hover 出下拉面板，需点击"去推广"才进入 buyin。
  //   先 hover 精选联盟 → 等下拉渲染 → 点击"去推广"（避开小字，选宽度>100 的面板项）。
  let jxPos = await findNavByText(fxgConn.send, '精选联盟', { yMax: 80 });
  if (!jxPos) throw new Error('NOT_FOUND: 精选联盟');
  console.log('  hover 精选联盟 @(' + jxPos.x + ',' + jxPos.y + ')');
  await mouseMove(fxgConn.send, jxPos.x, jxPos.y);
  await sleep(1500);

  const promoteJS = `(function(){
    var all=document.querySelectorAll('a,div,li,span');
    var cands=[];
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      if(t==='去推广'){
        var r=e.getBoundingClientRect();
        if(r.width>100&&r.height>10&&r.x>0&&r.y>0&&r.y<200){
          cands.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});
        }
      }
    }
    if(cands.length) return JSON.stringify(cands[0]);
    return JSON.stringify({nf:1});
  })()`;
  let qgPos = JSON.parse(((await evalJS(fxgConn.send, promoteJS, 3)) || {}).value || '{}');
  if (!qgPos.x) {
    // 兜底：直接点原位置（兼容旧版无下拉）
    console.log('  未找到去推广下拉项，直接点击 精选联盟');
    await clickAt(fxgConn.send, jxPos.x, jxPos.y);
  } else {
    console.log('  点击 去推广 @(' + qgPos.x + ',' + qgPos.y + ')');
    await mouseMove(fxgConn.send, qgPos.x, qgPos.y);
    await sleep(500);
    await clickAt(fxgConn.send, qgPos.x, qgPos.y);
  }

  // [3] 等待 buyin 新标签页出现（最多重试 3 次，每次重试前重新清屏）
  console.log('\n[3/9] 等待 buyin 标签页...');
  let buyin = null;
  for (let attempt = 0; attempt < 3 && !buyin; attempt++) {
    if (attempt > 0) {
      console.log('  第' + (attempt+1) + '次重试：重新清屏 + 点击...');
      await forceClearFxgPage(fxgConn);
      await sleep(1000);
      // 重新定位精选联盟（可能页面结构变了）
      const retryPos = await findNavByText(fxgConn.send, '精选联盟', { yMax: 80 });
      if (retryPos) {
        await clickAt(fxgConn.send, retryPos.x, retryPos.y);
      }
    }
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      targets = await httpGet('/json/list');
      for (const t of targets) {
        // [修复 2026-07-28] 中转可能落到 www.douyinec.com（URL 不含 buyin），一并识别为 buyin 新标签
        if (t.type === 'page' && t.url && (t.url.includes('buyin') || t.url.includes('douyinec.com')) && !fxgTabsBefore.has(t.id)) { buyin = t; break; }
      }
      if (buyin) break;
    }
  }
  // [Fallback 2026-08-12] 「去推广」点击持续失败时，用 CDP /json/new 接口直接创建 buyin 标签
  if (!buyin) {
    console.log('  ⚠ NO_BUYIN_TAB fallback: 通过 CDP /json/new 打开 buyin dashboard...');
    try {
      // 用 Node http 模块调用 Chrome 调试接口创建新标签（不受弹窗拦截，需 PUT 方法）
      const http = require('http');
      await new Promise((res,rej)=>{
        const req = http.request('http://127.0.0.1:9222/json/new?https://buyin.jinritemai.com/dashboard/data/operating', {method:'PUT'}, r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);console.log('  /json/new:', j.url||j.message||'ok');}catch(e){console.log('  /json/new raw:', d.slice(0,120));}res();});});
        req.on('error',e=>{console.log('  /json/new error:', e.message);rej();});
        req.end();
      });
      for (let fi = 0; fi < 15 && !buyin; fi++) {
        await sleep(1000);
        const targets2 = await httpGet('/json/list');
        for (const t of targets2) {
          if (t.type === 'page' && t.url && (t.url.includes('buyin') || t.url.includes('douyinec.com')) && !fxgTabsBefore.has(t.id)) { buyin = t; break; }
        }
      }
      if (buyin) console.log('  ✓ Fallback buyin: ' + buyin.url.slice(0, 60));
      else console.log('  ✗ Fallback 也失败：未检测到新 buyin 标签');
    } catch (fe) { console.log('  ✗ Fallback 异常: ' + fe.message); }
  }
  fxgConn.close();
  if (!buyin) throw new Error('NO_BUYIN_TAB');
  console.log('  buyin: ' + buyin.url.slice(0, 60));

  // [4] 等登录中转 + 关弹窗
  console.log('\n[4/9] 等登录中转...');
  await sleep(8000);
  const buyinConn = await connectToTarget(buyin.webSocketDebuggerUrl);
  await sleep(2000);
  console.log('  关弹窗...');
  await closePopups(buyinConn);

  // [M9] 打破 buyin 中转死循环：detected 仍在 redirectBuyin 中转页则主动跳到 dashboard
  // [修复 2026-07-28] 中转还可能落到 www.douyinec.com 等营销页（非 buyin 域名，无"看数据"），
  //   一并主动导航到 buyin dashboard（登录态已在中转时写入，直接导航有效）。
  for (let bi = 0; bi < 3; bi++) {
    const urlCheck = await evalJS(buyinConn.send, 'location.href', 2);
    const cur = (urlCheck && urlCheck.value) || '';
    console.log('  buyin 当前 URL: ' + cur.slice(0, 70));
    const onBuyin = cur.indexOf('buyin.jinritemai.com') >= 0;
    if (cur.indexOf('redirectBuyin') >= 0 || cur.indexOf('login/transfer') >= 0 || !onBuyin) {
      console.log('  检测到中转/非buyin页(' + (onBuyin ? '中转' : '如 douyinec.com') + ')，主动导航到 dashboard...');
      try { await buyinConn.send('Page.navigate', { url: 'https://buyin.jinritemai.com/dashboard' }, 15000); } catch (e) {}
      await sleep(6000);
      await closePopups(buyinConn);
    } else {
      break;
    }
    await sleep(1000);
  }

  // [5] 点击顶部"看数据"
  console.log('\n[5/9] 点击"看数据"...');
  const ksjJS = `(function(){
    // 1) 常见顶部菜单类名
    var all=document.querySelectorAll('li.auxo-menu-overflow-item, [class*="headerNav-item"], [class*="menu-item"], [class*="nav-item"], [class*="tab-item"], [role="menuitem"]');
    for(var i=0;i<all.length;i++){
      if((all[i].textContent||'').trim()==='看数据'){
        var r=all[i].getBoundingClientRect();
        if(r.width>10) return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
      }
    }
    // 2) 放宽兜底：只要节点自身文本精确为"看数据"且在顶部导航区域即可
    var all2=document.querySelectorAll('*');
    for(var i=0;i<all2.length;i++){
      var el=all2[i];
      if(el.tagName==='SCRIPT'||el.tagName==='STYLE'||el.tagName==='NOSCRIPT') continue;
      var text=(el.childNodes[0]&&el.childNodes[0].nodeType===3)?(el.childNodes[0].textContent||'').trim():'';
      if(text==='看数据'||(el.textContent||'').trim()==='看数据'){
        var r=el.getBoundingClientRect();
        if(r.width>10 && r.y<120 && r.x>200) return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
      }
    }
    return JSON.stringify({nf:1});
  })()`;
  // [M9] 看数据按钮需等 dashboard 渲染完；最多重试 4 次，每次关弹窗+等待
  let ksjPos = null;
  for (let kt = 0; kt < 4 && !ksjPos; kt++) {
    await closePopups(buyinConn);
    ksjPos = JSON.parse(((await evalJS(buyinConn.send, ksjJS, 5))||{}).value || '{}');
    if (!ksjPos.x) { console.log('  "看数据"未定位，等待重试 (' + (kt + 1) + '/4)...'); ksjPos = null; await sleep(2500); }
  }
  // 兜底：若始终找不到导航，直接跳到 operating 数据页
  if (!ksjPos) {
    console.log('  未定位到"看数据"，直接导航到 /dashboard/data/operating ...');
    try { await buyinConn.send('Page.navigate', { url: 'https://buyin.jinritemai.com/dashboard/data/operating' }, 15000); } catch (e) {}
    await sleep(8000);
    await closePopups(buyinConn);
  } else {
    await clickAt(buyinConn.send, ksjPos.x, ksjPos.y);
    await sleep(5000);
  }

  // 等页面加载完成后可能出弹窗
  await closePopups(buyinConn);

  // 验证是否在 operating 页面，若不在则重试点击看数据
  // [修复 2026-07-28] 点击"看数据"可能被新版引导/弹窗吞掉（点击后 URL 始终不变，5 次重试无效）。
  //   retry>=2 后放弃点击，直接 Page.navigate 到已知数据页 URL（确定性兜底）。
  for (let retry = 0; retry < 5; retry++) {
    const urlCheck = await evalJS(buyinConn.send, 'location.href', 2);
    const currentUrl = urlCheck?.value || '';
    const cWidthJS = `(function(){var c=document.querySelector('canvas');return c?Math.round(c.getBoundingClientRect().width):0})()`;
    const cW = parseInt(((await evalJS(buyinConn.send, cWidthJS, 2))||{}).value||'0');
    console.log('  第' + (retry+1) + '次检查: URL=' + (currentUrl.includes('operating')?'operating ✓':'NOT operating'), 'Canvas=' + cW + 'px');
    if (currentUrl.includes('operating') && cW > 1000) break;
    if (!currentUrl.includes('operating')) {
      await closePopups(buyinConn);
      if (retry >= 1) {
        console.log('  点击无效，直接导航到 /dashboard/data/operating ...');
        try { await buyinConn.send('Page.navigate', { url: 'https://buyin.jinritemai.com/dashboard/data/operating' }, 15000); } catch (e) {}
        await sleep(8000);
      } else {
        // 重新点击看数据
        await clickAt(buyinConn.send, ksjPos.x, ksjPos.y);
        await sleep(5000);
      }
      await closePopups(buyinConn);
    }
    if (cW < 1000) {
      await closePopups(buyinConn);
      await sleep(3000);
    }
  }

  // [6] 设置勾选状态：仅"预估佣金支出"（CDP 鼠标点击）
  console.log('\n[6/9] 设置 checkbox: 仅"预估佣金支出"...');
  await closePopups(buyinConn);

  // 改用 CDP 鼠标点击（真实坐标），之前实验证明部分 checkbox 可以
  // 2026-07-29 修复：抽成函数——页面刷新后 checkbox 会重置回默认（投放商品数），
  // 刷新后必须重新勾选，否则 hover 抓到的是错误指标（曾抓到"投放商品数:39"×7天）
  // 2026-08-07 修复：部分店铺 input.auxo-checkbox-input 的 CDP 坐标点击无效，
  // 改为优先点击关联 label，再兜底 input.click()，并增加点击后状态校验。
  async function ensureCommissionCheckbox() {
    let ok = false;
    for (let tryN = 0; tryN < 5 && !ok; tryN++) {
      // 取当前状态（同时收集 label 坐标用于点击）
      const cbsR2 = JSON.parse(((await evalJS(buyinConn.send, `JSON.stringify([...document.querySelectorAll('input.auxo-checkbox-input')].map((cb,i)=>{
        var p=cb.closest('[class*="statisticsCard"]');
        var r=cb.getBoundingClientRect();
        var label=cb.closest('label') || document.querySelector('label[for="'+cb.id+'"]') || cb.parentElement;
        var lr=label?label.getBoundingClientRect():r;
        return {i:i,t:p?(p.innerText||'').replace(/\\s+/g,' ').slice(0,20):'',c:cb.checked,
          x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
          lx:Math.round(lr.x+lr.width/2),ly:Math.round(lr.y+lr.height/2)}
      }))`, 2))||{}).value || '[]');
      ok = cbsR2.length > 0 && cbsR2.every(c => c.t.indexOf('预估佣金支出') >= 0 ? c.c : !c.c);
      if (ok) break;

      // 只点击需要改变的
      for (const c of cbsR2) {
        const isYj = c.t.indexOf('预估佣金支出') >= 0;
        if ((isYj && !c.c) || (!isYj && c.c)) {
          console.log('    点击 ' + c.t, '@(' + c.lx + ',' + c.ly + ')[label]');
          // 优先点击 label 中心
          await clickAt(buyinConn.send, c.lx, c.ly);
          await sleep(600);
          // 校验单条是否翻转，未翻转再点 input 中心
          const now = JSON.parse(((await evalJS(buyinConn.send, `JSON.stringify([...document.querySelectorAll('input.auxo-checkbox-input')].map((cb,i)=>{var p=cb.closest('[class*="statisticsCard"]');return {i:i,t:p?(p.innerText||'').replace(/\\s+/g,' ').slice(0,20):'',c:cb.checked}}).filter(x=>x.i===` + c.i + `))`, 2))||{}).value || '[]');
          if (now[0] && ((isYj && !now[0].c) || (!isYj && now[0].c))) {
            console.log('      label 点击未生效，改点 input @(' + c.x + ',' + c.y + ')');
            await clickAt(buyinConn.send, c.x, c.y);
            await sleep(600);
          }
          const now2 = JSON.parse(((await evalJS(buyinConn.send, `JSON.stringify([...document.querySelectorAll('input.auxo-checkbox-input')].map((cb,i)=>{var p=cb.closest('[class*="statisticsCard"]');return {i:i,t:p?(p.innerText||'').replace(/\\s+/g,' ').slice(0,20):'',c:cb.checked}}).filter(x=>x.i===` + c.i + `))`, 2))||{}).value || '[]');
          if (now2[0] && ((isYj && !now2[0].c) || (!isYj && now2[0].c))) {
            console.log('      坐标点击均未生效，改用 DOM input.click()');
            await evalJS(buyinConn.send, `(function(){ var cbs=[...document.querySelectorAll('input.auxo-checkbox-input')]; var cb=cbs[` + c.i + `]; if(cb){ cb.scrollIntoView({block:'center',inline:'center'}); cb.click(); } return 1; })()`, 2);
            await sleep(800);
          }
        }
      }
      await sleep(1500);
    }
    if (!ok) console.log('  ⚠️  checkbox 状态可能不完全正确');
    return ok;
  }
  const allCorrect = await ensureCommissionCheckbox();

  // 打印状态
  const cbsFinal = JSON.parse(((await evalJS(buyinConn.send, `JSON.stringify([...document.querySelectorAll('input.auxo-checkbox-input')].map(cb=>{var p=cb.closest('[class*="statisticsCard"]');return {t:p?(p.innerText||'').replace(/\\s+/g,' ').slice(0,20):'',c:cb.checked}}))`, 2))||{}).value || '[]');
  cbsFinal.forEach(c => console.log('    ' + (c.c ? '☑' : '☐') + ' ' + c.t));
  await sleep(2000);

  // [7] Canvas 扫描 + 精确 hover + Tooltip 提取
  console.log('\n[7/9] Canvas 扫描 + 精确 hover...');

  // 先检查 canvas 状态（轮询：图表异步渲染，rect 可能暂时不存在 / 宽 0 / 被弹窗遮挡）
  const CANVAS_RECT_JS = `(function(){var c=document.querySelector('canvas');if(!c)return'{}';var r=c.getBoundingClientRect();return JSON.stringify({sx:Math.round(r.x),sy:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)})})()`;
  const readCanvasRect = async () => {
    try {
      const r = await evalJS(buyinConn.send, CANVAS_RECT_JS, 3);
      const p = JSON.parse((r || {}).value || '{}');
      if (p && Number.isFinite(p.sx) && Number.isFinite(p.sy) && Number.isFinite(p.w) && Number.isFinite(p.h)) return p;
    } catch (e) {}
    return null;
  };

  let cPos = null;
  for (let t = 0; t < 8; t++) {
    cPos = await readCanvasRect();
    console.log('  Canvas 屏幕: ' + (cPos ? '(' + cPos.sx + ',' + cPos.sy + ') ' + cPos.w + 'x' + cPos.h : '未渲染/无 canvas') + (t ? '  [重试 ' + t + ']' : ''));
    if (cPos && cPos.w >= 800) break;
    console.log('  ⚠️  Canvas 未就绪（不存在或太小），关弹窗后等待重试...');
    await closePopups(buyinConn);
    await sleep(2500 + Math.floor(Math.random() * 1500));
    // 第 4 次仍不行：刷新页面并重设 checkbox（刷新会把指标重置回默认）
    if (t === 3) {
      console.log('  刷新页面重建图表...');
      try { await buyinConn.send('Page.reload', { ignoreCache: false }, 15000); } catch (e) {}
      await sleep(7000 + Math.floor(Math.random() * 2000));
      await closePopups(buyinConn);
      await ensureCommissionCheckbox();
      await sleep(1800 + Math.floor(Math.random() * 800));
    }
  }
  if (!cPos || !Number.isFinite(cPos.sx) || cPos.w < 800) {
    throw new Error('NO_CANVAS: 图表未渲染或被遮挡（rect=' + JSON.stringify(cPos) + '）');
  }

  // 扫描蓝线（scanBlueLine 内部已对"图表未渲染完"重试 4 次）
  // 兜底日期：实时日期前 7 天（与数据最后一天无关）
  const now = new Date();
  const fallbackDates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    fallbackDates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }

  let ys, xs, emptyMode = false;
  try {
    const sr = await scanBlueLine(buyinConn.send);
    if (sr && sr.empty) emptyMode = true;
    else { ys = sr.ys; xs = sr.xs; }
  } catch (e) {
    console.log('  ⚠️ 首次 Canvas 扫描异常: ' + e.message + '，转入重试循环...');
    ys = [null, null, null, null, null, null, null];
    xs = [null, null, null, null, null, null, null];
  }

  let values, dates;
  if (emptyMode) {
    // 空态（暂无数据）：联盟佣金记为 0，跳过 hover 采集，直接进入写文件
    console.log('\n  === 图表空态（暂无数据）：联盟佣金按 0 处理 ===');
    values = [0, 0, 0, 0, 0, 0, 0];
    dates = fallbackDates.slice();
  } else {
  let scanTry = 0;
  for (; scanTry < 15 && ys.every(y => y == null); scanTry++) {
    // 每 5 次失败刷新一次页面
    if (scanTry === 5 || scanTry === 10) {
      console.log('  扫描失败 ' + (scanTry+1) + ' 次，刷新页面...');
      try { await buyinConn.send('Page.reload', { ignoreCache: false }, 15000); } catch(e) {}
      await sleep(7000 + Math.floor(Math.random() * 2000));
      // 刷新后 checkbox 被重置为默认，必须重新勾选"仅预估佣金支出"
      await closePopups(buyinConn);
      console.log('  刷新后重新设置 checkbox...');
      await ensureCommissionCheckbox();
      await sleep(1800 + Math.floor(Math.random() * 800));
    }
    if (scanTry === 5) {
      // 截图诊断
      try {
        const scr = await buyinConn.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(PROJECT_DIR, 'step5-wait-scan.png'), Buffer.from(scr.data, 'base64'));
        console.log('  截图: step5-wait-scan.png');
      } catch(e) {}
      // 扫描所有非浅色像素看有没有任何线
      const anyColorJS = `(function(){
        var c=document.querySelector('canvas'); if(!c) return '{}';
        var r=c.getBoundingClientRect(); var w=Math.round(r.width),h=Math.round(r.height);
        var ctx=c.getContext('2d'); var img=ctx.getImageData(0,0,w,h); var d=img.data;
        var colors={};
        for(var y=0;y<h;y+=2){ for(var x=50;x<Math.min(w,200);x+=2){
          var idx=(y*w+x)*4; var r2=d[idx],g2=d[idx+1],b2=d[idx+2],a2=d[idx+3];
          if(a2<150) continue; if(r2>240&&g2>240&&b2>240) continue;
          var key=r2+','+g2+','+b2; colors[key]=(colors[key]||0)+1;
        }}
        return JSON.stringify(Object.entries(colors).sort((a,b)=>b[1]-a[1]).slice(0,10));
      })()`;
      const allColors = JSON.parse(((await evalJS(buyinConn.send, anyColorJS, 3))||{}).value||'[]');
      console.log('  Canvas 非白颜色:');
      allColors.forEach(c => console.log('    RGB('+c[0]+') x'+c[1]));
    }
    // [风控优化 2026-08-13] 扫描重试间隔随机抖动
    await sleep(1800 + Math.floor(Math.random() * 900));
    try {
      const scanRetry = await scanBlueLine(buyinConn.send);
      if (scanRetry && scanRetry.empty) { emptyMode = true; break; }
      ys = scanRetry.ys; xs = scanRetry.xs;
    } catch (e) {
      console.log('  ⚠️ 重试扫描异常: ' + e.message + '（保持 null，继续重试）');
      ys = [null, null, null, null, null, null, null];
      xs = [null, null, null, null, null, null, null];
    }
  }
  if (emptyMode) {
    console.log('\n  === 重试中发现空态（暂无数据）：联盟佣金按 0 处理 ===');
    values = [0, 0, 0, 0, 0, 0, 0];
    dates = fallbackDates.slice();
  } else {
  console.log('  扫描尝试: ' + (scanTry + 1) + ' 次');
  console.log('  7 个 x:', JSON.stringify(xs));
  console.log('  7 个 y:', JSON.stringify(ys));
  if (ys.every(y => y == null)) throw new Error('NO_CHART_DATA: 多次重试后仍未找到佣金趋势线');

  // 精确 hover 每个点，读 tooltip
  values = [];
  dates = [];

  for (let i = 0; i < 7; i++) {
    if (ys[i] == null) {
      console.log('\n  --- 点 ' + i + ' (' + fallbackDates[i] + ') : y=null, 跳过 ---');
      values.push(null); dates.push(fallbackDates[i]);
      continue;
    }

    // canvas 像素坐标 → 屏幕坐标
    const sx = xs[i] + cPos.sx;
    const sy = ys[i] + cPos.sy;
    console.log('\n  --- 点 ' + i + ' (' + fallbackDates[i] + ') canvas(' + xs[i] + ',' + ys[i] + ') screen(' + sx + ',' + sy + ') ---');
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
      console.log('  ⚠️ 坐标非法（NaN），跳过该点');
      values.push(null); dates.push(fallbackDates[i]);
      continue;
    }

    // 先检查弹窗
    await closePopups(buyinConn);

    // 移动到前一个位置（制造连续移动轨迹）
    if (i > 0 && ys[i - 1] != null) {
      const px = xs[i - 1] + cPos.sx;
      const py = ys[i - 1] + cPos.sy;
      await mouseMove(buyinConn.send, px, py);
      await sleep(300);
    }

    // 先读 before 快照
    const before = await getTextSnapshot(buyinConn.send, cPos.sx, cPos.sy);

    // 移动到线上
    await mouseMove(buyinConn.send, sx, sy);
    await sleep(1500);

    // 读 after 快照
    const after = await getTextSnapshot(buyinConn.send, cPos.sx, cPos.sy);
    const newTexts = diffSnapshots(before, after);

    if (newTexts.length > 0) {
      console.log('  NEW (' + newTexts.length + ' items):');
      newTexts.slice(0, 3).forEach(e => console.log('    [' + e.w + 'x' + e.h + '] ' + e.t.slice(0, 80)));

      // 优先：找含"预估佣金"的容器
      const yjItem = newTexts.find(e => e.t.indexOf('预估佣金') >= 0);
      // 其次：找同时含日期和"元"的
      const mixedItem = newTexts.find(e => /2026/.test(e.t) && /元/.test(e.t));
      // 第三：最宽的（tooltip 通常是宽盒子）
      const widest = newTexts[0]; // 已按大小排序

      let best = yjItem || mixedItem || widest;
      // 2026-07-29 修复：指标校验——若 tooltip 是其它指标（投放/动销商品数、成交单量等），
      // 说明 checkbox 状态错了，绝不能把它当佣金值（曾把"投放商品数:39"写进报表）
      if (best && best.t.indexOf('预估佣金') < 0 && /(商品数|成交单量|退款单量|达人数|成交金额|退款金额)/.test(best.t)) {
        console.log('  ✗ tooltip 为错误指标（非预估佣金支出），丢弃: ' + best.t.replace(/\s+/g, ' ').slice(0, 40));
        best = null;
      }
      if (best) {
        // 先提取 tooltip 中的日期
        const dm = (best.t || '').match(/(\d{4}\/\d{2}\/\d{2})/);
        const dStr = dm ? dm[1].replace(/\//g, '-') : fallbackDates[i];

        let val = null;
        const yuanMatch = (best.t || '').match(/([\d,]+(?:\.\d+)?)\s*元/);
        if (yuanMatch) val = parseFloat(yuanMatch[1].replace(/,/g, ''));
        if (val == null || isNaN(val)) {
          const cm = (best.t || '').match(/佣金[支出]*[：:]\s*([\d,]+(?:\.\d+)?)/);
          if (cm) val = parseFloat(cm[1].replace(/,/g, ''));
        }
        if (val == null || isNaN(val)) {
          const dm2 = (best.t || '').match(/([\d,]+\.\d{1,2})\b/);
          if (dm2) val = parseFloat(dm2[1].replace(/,/g, ''));
          if (val == null || isNaN(val)) {
            const im = (best.t || '').match(/[：:]\s*([\d,]+)\b/);
            if (im) val = parseFloat(im[1].replace(/,/g, ''));
          }
        }
        if (typeof val === 'number' && !isNaN(val)) {
          values.push(val);
          dates.push(dStr);
          console.log('  → ' + dStr + ' : ' + val + '元');
        } else {
          values.push(null); dates.push(fallbackDates[i]);
          console.log('  ✗ 未能解析');
        }
      } else {
        values.push(null); dates.push(fallbackDates[i]);
      }
    } else {
      console.log('  首次无新元素，重试...');
      await sleep(1000);
      await mouseMove(buyinConn.send, sx + 3, sy - 3);
      await sleep(1500);
      const after2 = await getTextSnapshot(buyinConn.send, cPos.sx, cPos.sy);
      const newTexts2 = diffSnapshots(before, after2);
      if (newTexts2.length > 0) {
        console.log('  NEW (retry ' + newTexts2.length + ' items):');
        newTexts2.slice(0, 2).forEach(e => console.log('    [' + e.w + 'x' + e.h + '] ' + e.t.slice(0, 80)));
        const best2 = newTexts2.find(e => e.t.indexOf('预估佣金') >= 0) || newTexts2[0];
        const dm3 = (best2?.t || '').match(/(\d{4}\/\d{2}\/\d{2})/);
        const d3 = dm3 ? dm3[1].replace(/\//g, '-') : fallbackDates[i];
        const m3 = (best2?.t || '').match(/佣金[支出]*[：:]\s*([\d,]+(?:\.\d+)?)/);
        const val = m3 ? parseFloat(m3[1].replace(/,/g, '')) : null;
        values.push(val); dates.push(d3);
        console.log('  → ' + val + '元 @ ' + d3);
      } else {
        values.push(null); dates.push(fallbackDates[i]);
        console.log('  ✗ 无 tooltip');
      }
    }
  }
  } // end !emptyMode (hover path)
  } // end else (non-empty top)

  const validValues = values.filter(v => v != null);
  console.log('\n  === 最终数据 (' + validValues.length + '/' + values.length + ' 天有数据) ===');
  for (let i = 0; i < dates.length; i++) {
    console.log('  ' + dates[i] + ': ' + (values[i] != null ? values[i].toFixed(2) : 'null'));
  }
  if (validValues.length === 0) throw new Error('NO_VALID_VALUES');

  // [8] 生成 Excel
  console.log('\n[8/9] 生成 Excel...');
  const actualDates = dates.filter((d, i) => values[i] != null);
  // 报表始终以实时日期的前一天命名（与数据最后一天无关）
  const reportDate = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0,10); })();
  const fileName = reportDate + '_' + BRAND + '_日常报表.xlsx';
  const destFolder = path.join(PROJECT_DIR, reportDate);
  if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
  const destPath = path.join(destFolder, fileName);
  console.log('  ' + destPath);

  const workDir = path.join(process.env.DD_TMP_DIR || 'C:/tmp', 'xlsx-step5-' + Date.now());
  fs.mkdirSync(workDir, { recursive: true });
  copyDirSync(XLSX_TPL, workDir);

  const sheetPath = path.join(workDir, 'xl/worksheets/sheet1.xml');
  if (fs.existsSync(sheetPath)) {
    let xml = fs.readFileSync(sheetPath, 'utf-8');
    let rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>日期</t></is></c><c r="B1" t="inlineStr"><is><t>预估佣金支出(元)</t></is></c></row>';
    values.forEach((v, i) => {
      const rowNum = i + 2;
      const dateCell = '<c r="A' + rowNum + '" t="inlineStr"><is><t>' + dates[i] + '</t></is></c>';
      const valCell = '<c r="B' + rowNum + '"><v>' + ((v != null) ? v.toFixed(2) : '0') + '</v></c>';
      rows += '<row r="' + rowNum + '">' + dateCell + valCell + '</row>';
    });
    xml = xml.replace(/<sheetData>.*?<\/sheetData>/s, '<sheetData>' + rows + '</sheetData>');
    fs.writeFileSync(sheetPath, xml);
  }

  try {
    execSync('"' + PYTHON + '" "' + XLSX_PACK + '" "' + workDir + '" "' + destPath + '"', { stdio: 'inherit' });
    console.log('  ✓ Excel 生成成功');
  } catch (e) { console.log('  ✗ Excel 生成失败:', e.message); }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}

  // [9] 收尾
  console.log('\n[9/9] 收尾...');
  await closeAllNonFxgTabs();
  buyinConn.close();
  console.log('\n✅ 第五步完成！Excel:', destPath);
  process.exit(0);
}

main().catch(async e => {
  console.error('FATAL:', e && e.message);
  try { await require('./fail-capture.cjs').captureOnFail('step5-' + (process.env.DOUDIAN_BRAND || ''), e && e.message); } catch (_) {}
  process.exit(1);
});
