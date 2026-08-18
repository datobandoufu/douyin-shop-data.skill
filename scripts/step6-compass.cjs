// step6-compass.cjs — 第六步：电商罗盘 导出 商品/达人/交易 三个明细
// ====================================================================
// 流程：
//   1. 抖店 fxg 顶部点击「电商罗盘」→ 新标签 compass.jinritemai.com
//   2. 关弹窗（Escape + 我知道了/知道了）
//   3. 三个子任务：
//      A. 点击「商品」→ 点「近1天」→ hover「下载明细」→ 点击下拉项「下载当前明细」
//         归档：{date}_{品牌}_商品列表.xlsx
//      B. 点击「达人」→ 点击「合作达人」→ 点「近1天」→ hover「下载明细」→ 点击下拉项
//         归档：{date}_{品牌}_达人列表.xlsx
//      C. 点击「交易」→ 点「近1天」→ hover「下载明细」→ 点击下拉项
//         归档：{date}_{品牌}_交易明细.xlsx
//   4. 关闭非抖店标签
// ====================================================================

const WebSocket = global.WebSocket;
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const CDP_BASE = 'http://localhost:' + PORT;
const PROJECT_DIR = path.join(__dirname, '..');
const BRAND = process.env.DOUDIAN_BRAND || process.env.DD_SHOP_A || '店铺A';
const DL_DIR = process.env.DD_DL_DIR || 'C:/tmp/doudian-dl';

// 三个子任务配置
const SUBTASKS = [
  {
    name: '商品',
    navX: 927, navY: 22,
    downloadBtnX: null, downloadBtnY: null,  // 运行时定位
    // [下载机制] 商品页「下载明细」同交易页，是下拉触发器：必须 hover 展开 → 点「下载当前明细」子项才下载。
    // 仅「达人」页是直点按钮。故商品也走 useDropdown 分支（2026-08-04 用户确认）。
    useDropdown: true,
    dropdownItem: '下载当前明细',
    fileSuffix: '商品列表',
    needSubTab: null,
    // [归属校验] 抖店下载文件名关键词，防止上一子任务迟到落盘的文件被误归档（串档）
    nameKeys: ['商品列表', '商品_'],
  },
  {
    name: '达人',
    navX: 868, navY: 22,
    downloadBtnX: null, downloadBtnY: null,
    fileSuffix: '达人列表',
    needSubTab: { x: 442, y: 235, name: '合作达人' },
    nameKeys: ['达人'],
  },
  {
    name: '交易',
    navX: 479, navY: 22,
    // [交易下载修复] 交易页「下载明细」是下拉触发器(ecom-dropdown-trigger)，
    // 直接点不会触发下载，必须先 hover 展开 → 点「下载当前明细」子项(DOM 直点)才真正下载。
    // 故 useDropdown=true，且 downloadBtnX 置空改用 findDownloadBtn 动态定位。
    downloadBtnX: null, downloadBtnY: null,
    useDropdown: true,
    dropdownItem: '下载当前明细',
    fileSuffix: '交易明细',
    needSubTab: null,
    nameKeys: ['成交', '交易'],
  },
];

function httpGet(p) { return new Promise((res, rej) => { http.get(CDP_BASE + p, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej).setTimeout(2000, () => rej(new Error('T'))); }); }
// Chrome 111+ 起 /json/new 只接受 PUT（GET 会 405），开新标签必须走这里。
function httpPut(p) { return new Promise((res, rej) => { const req = http.request(CDP_BASE + p, { method: 'PUT' }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }); req.on('error', rej); req.setTimeout(5000, () => { req.destroy(); rej(new Error('T')); }); req.end(); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectToTarget(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  function send(method, params = {}, timeoutMs = 20000) {
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
      await Promise.allSettled([send('Page.enable', {}, 5000), send('Runtime.enable', {}, 5000), send('Network.enable', {}, 5000), send('Emulation.enable', {}, 5000)]);
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
    catch (e) { if (i < retries - 1) await sleep(800); else throw e; }
  }
}

async function clickAt(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function mouseMove(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

// [B1 防污染] 读取 compass 页面顶栏店铺名（userName 处，可能带"早上好，"前缀）。
// 返回空串表示未读到（将判为校验失败，终止以防污染）。
async function readCompassBrand(send) {
  const js = `(function(){
    var el = document.querySelector('[class*="userName"]');
    return el ? (el.textContent||'').trim() : '';
  })()`;
  try { const r = await evalJS(send, js, 3); return (r && r.value) || ''; } catch (e) { return ''; }
}

// =================== 弹窗处理 ===================

async function closePopups(wsConn) {
  let total = 0;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 2; i++) {
      try { await wsConn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
      try { await wsConn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
      await sleep(200);
    }
    const btnsJS = `(function(){
      var all=document.querySelectorAll('button,span,div');
      var out=[];
      for(var i=0;i<all.length;i++){
        var el=all[i]; var t=(el.textContent||'').trim();
        if((t==='我知道了'||t==='知道了')&&el.children.length===0){
          var r=el.getBoundingClientRect();
          if(r.width>10&&r.height>8&&r.x>0&&r.y>0) out.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
        }
      }
      return JSON.stringify(out);
    })()`;
    const btns = JSON.parse(((await evalJS(wsConn.send, btnsJS, 2))||{}).value || '[]');
    if (btns.length === 0) break;
    for (const b of btns) { await clickAt(wsConn.send, b.x, b.y); await sleep(600); total++; }
  }
  return total;
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

// =================== 日期读取 ===================

async function clickNear1Day(send) {
  // 点击"近1天"按钮（按文本定位，去掉绝对坐标硬筛，避免窗口尺寸/分辨率变化点空）
  const posJS = `(function(){
    var all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){
      var e=all[i];
      var t=(e.textContent||'').trim();
      if(t==='近1天'||t.indexOf('近1天')>=0&&t.length<10){
        var r=e.getBoundingClientRect();
        if(r.width>10&&r.height>10){
          return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
        }
      }
    }
    return JSON.stringify({nf:1});
  })()`;
  const pos = JSON.parse(((await evalJS(send, posJS, 3))||{}).value || '{}');
  if (!pos.x) {
    console.log('  ⚠️  未找到"近1天"按钮');
    return false;
  }
  await clickAt(send, pos.x, pos.y);
  await sleep(3000);
  return true;
}

function readYesterdayDate() {
  // 统一使用运行时前一天作为数据日期
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// =================== 按文本定位顶部导航（替代硬编码坐标，R4） ===================
// 在 compass 页面顶部区域按文本精确匹配导航项（商品/达人/交易/合作达人等），
// 返回中心坐标；找不到时返回 null，由调用方回退到硬编码坐标兜底。
async function findNavByText(send, text, opts = {}) {
  const yMax = opts.yMax || 300;          // 顶部区域高度限制
  const maxLen = opts.maxLen || (text.length + 4); // 文本长度上限（避免匹配到大容器）
  const js = `(function(){
    var TXT=${JSON.stringify(text)}, YMAX=${yMax}, MAXLEN=${maxLen};
    function isTopNav(e){ var p=e; for(var k=0;k<5&&p;k++){ var cl=(p.className||'').toString(); var id=(p.id||''); if(cl.indexOf('menuItem')>=0||cl.indexOf('nav-menu')>=0||cl.indexOf('navMenu')>=0||id==='fxg-pc-header') return 1; p=p.parentElement; } return 0; }
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
        exact:(t===TXT)?1:0, leaf:(e.children.length===0)?1:0, len:t.length, top:r.y, left:r.x,
        nav:isTopNav(e)});
    }
    // 排序：顶栏导航项 > 精确匹配 > 叶子节点 > 文本更短 > 更靠上 > 更靠左
    // （nav 偏好可排除 hover 浮层/下拉面板内的同名文本副本，如 @326,32 偏移项）
    cands.sort(function(a,b){
      return (b.nav-a.nav)||(b.exact-a.exact)||(b.leaf-a.leaf)||(a.len-b.len)||(a.top-b.top)||(a.left-b.left);
    });
    return JSON.stringify(cands[0]||{nf:1});
  })()`;
  try {
    const pos = JSON.parse(((await evalJS(send, js, 3)) || {}).value || '{}');
    if (pos && pos.x) return { x: pos.x, y: pos.y };
  } catch (e) {}
  return null;
}

// 点击导航：优先按文本定位，失败回退到硬编码坐标
async function clickNav(send, text, fallbackX, fallbackY, opts) {
  const pos = await findNavByText(send, text, opts);
  if (pos) {
    console.log('  按文本定位"' + text + '" @(' + pos.x + ',' + pos.y + ')');
    await clickAt(send, pos.x, pos.y);
    return true;
  }
  if (fallbackX != null) {
    console.log('  ⚠️ 文本定位"' + text + '"失败，回退硬编码坐标 @(' + fallbackX + ',' + fallbackY + ')');
    await clickAt(send, fallbackX, fallbackY);
    return true;
  }
  console.log('  ✗ 无法定位导航"' + text + '"');
  return false;
}

// =================== 找下载按钮 ===================

async function findDownloadBtn(send) {
  const dlJS = `(function(){
    var all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){
      var e=all[i];
      var t=(e.textContent||'').trim();
      if(t==='下载明细'||(t.indexOf('下载明细')>=0&&t.length<=10)){
        var r=e.getBoundingClientRect();
        if(r.width>10&&r.height>10&&r.x>800){
          return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});
        }
      }
    }
    // 兜底：找 class 含 download 的 button
    var btns=document.querySelectorAll('button,[class*="download"],[class*="Download"]');
    for(var i=0;i<btns.length;i++){
      var t2=(btns[i].textContent||'').trim();
      if(t2.indexOf('下载')>=0&&t2.length<15){
        var r2=btns[i].getBoundingClientRect();
        if(r2.width>10&&r2.height>10&&r2.x>800) return JSON.stringify({x:Math.round(r2.x+r2.width/2),y:Math.round(r2.y+r2.height/2),w:Math.round(r2.width),h:Math.round(r2.height)});
      }
    }
    return JSON.stringify({nf:1});
  })()`;
  return JSON.parse(((await evalJS(send, dlJS, 3))||{}).value || '{}');
}

// =================== 下载触发 + 抓取文件 ===================

async function triggerDownload(send, conn, dlURLs, btnX, btnY) {
  // [M2] 找下拉项"下载当前明细"，并校验是否在视口内；屏外先 scrollIntoView 再取坐标，避免点到负坐标
  const dropJS = `(function(){
    var all=document.querySelectorAll('*');
    var bestOff=null;
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      // [P0-fix] 放宽 children 限制：交易等菜单项可能带图标子元素(children>1)导致被漏匹配；
      // 用尺寸护栏(width<400,height<80)避免误命中大容器。
      if((t==='下载当前明细'||t.indexOf('下载当前明细')>=0)){
        var r=e.getBoundingClientRect();
        if(r.width>30&&r.width<400&&r.height>15&&r.height<80){
          var onscreen = r.x>0 && r.y>0 && (r.x+r.width)<=window.innerWidth && (r.y+r.height)<=window.innerHeight;
          if(onscreen) return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t,onscreen:true});
          if(!bestOff) bestOff={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t,onscreen:false};
        }
      }
    }
    return JSON.stringify(bestOff||{nf:1});
  })()`;
  const scrollJS = `(function(){
    var all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      if((t==='下载当前明细'||t.indexOf('下载当前明细')>=0)&&e.children.length<=1){
        var r=e.getBoundingClientRect();
        if(r.width>30&&r.height>15){ try{ e.scrollIntoView({block:'center', inline:'center'}); }catch(_){ if(e.parentElement) e.parentElement.scrollTop-=200; } return 1; }
      }
    }
    return 0;
  })()`;
  let drop = null;
  for (let retry = 0; retry < 4; retry++) {
    drop = JSON.parse(((await evalJS(send, dropJS, 3))||{}).value || '{}');
    if (drop.x && drop.onscreen) break;
    if (drop.x && !drop.onscreen) {
      // [M2-fixed] 命中但被渲染在视口外（fixed 离屏模板，scrollIntoView 无效）：
      // 不点屏外坐标，直接对该元素 DOM 直点触发下载，绕开屏幕坐标。
      console.log('  下拉项离屏 @(' + drop.x + ',' + drop.y + ')，改用 DOM 直点...');
      const ok = await domClickByText(send, '下载当前明细');
      if (ok) { console.log('  ✓ DOM 直点已触发下载'); return true; }
    }
    if (retry < 3) {
      // 重新 hover 触发下拉
      if (btnX) await mouseMove(send, btnX + Math.floor(Math.random() * 10) - 5, btnY + Math.floor(Math.random() * 10) - 5);
      await sleep(600);
    }
  }
  if (!drop.x) {
    console.log('  ⚠️  未找到"下载当前明细"下拉项（重试4次后仍失败）');
    return false;
  }
  console.log('  下拉项 @(' + drop.x + ',' + drop.y + ') text=' + drop.text);

  // 点击"下载当前明细"（视口内，坐标点）
  await clickAt(send, drop.x, drop.y);
  return true;
}

async function domClickByText(send, text) {
  // [M2-fixed] 找到匹配文本的元素后直接 DOM .click() + 派发合成事件，绕开屏幕坐标，
  // 兼容抖店把"下载当前明细"浮层钉在离屏 fixed 坐标的场景。
  const needle = JSON.stringify(text);
  const js = `(function(){
    var all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      // [P0-fix] 放宽 children 限制（菜单项可能带图标子元素），用尺寸护栏避免误命中大容器
      if((t===${needle}||t.indexOf(${needle})>=0)){
        var r=e.getBoundingClientRect();
        if(r.width>30&&r.width<400&&r.height>15&&r.height<80){
          try{
            // [重复下载修复] 只派发一次 click：e.click() + dispatchEvent 双触发
            // 会导致一次调用触发两次下载（实测 2026-08-13：商品/交易各多下载 1 次）。
            e.click();
            return JSON.stringify({ok:1});
          }catch(err){ return JSON.stringify({ok:0,err:String(err)}); }
        }
      }
    }
    return JSON.stringify({ok:0,err:'not found'});
  })()`;
  try {
    const r = await evalJS(send, js, 3);
    const v = r && r.value ? JSON.parse(r.value) : {};
    return v.ok === 1;
  } catch (e) { return false; }
}

async function downloadFile(url, saveDir) {
  let cookieStr = '';
  try {
    const cr = await new Promise((res, rej) => {
      http.get(CDP_BASE + '/json/version', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
    });
    // 用浏览器 fetch 拿 cookies 太复杂，直接从 document.cookie 拿
  } catch (e) {}

  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const urlObj = new URL(url);
  const fname = decodeURIComponent(path.basename(urlObj.pathname) || 'export.xlsx');
  const fpath = path.join(saveDir, fname);

  return new Promise((res, rej) => {
    const mod = urlObj.protocol === 'https:' ? require('https') : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*'
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, saveDir).then(res).catch(rej);
        return;
      }
      if (response.statusCode !== 200) { rej(new Error('HTTP ' + response.statusCode)); return; }
      const wstream = fs.createWriteStream(fpath);
      response.pipe(wstream);
      wstream.on('finish', () => { wstream.close(); res(fpath); });
      wstream.on('error', rej);
    });
    req.setTimeout(180000, () => { req.destroy(); rej(new Error('DL_TIMEOUT')); });
    req.on('error', rej);
  });
}

// =================== 主流程 ===================

async function main() {
  console.log('=== 第六步：电商罗盘 → 商品/达人/交易 明细导出 ===\n');

  // 1. 找 fxg 基准 tab
  let targets = await httpGet('/json/list');
  let fxg = targets.find(t => t.type === 'page' && t.url && t.url.includes('fxg.jinritemai.com'));
  if (!fxg) { console.error('✗ 未找到 fxg 基准页'); process.exit(1); }
  const fxgTabsBefore = new Set(targets.map(t => t.id));
  console.log('[1/4] 基准 fxg:', fxg.url.slice(0, 60));

  // 2. 点击顶部"电商罗盘"（先强力清屏确保点击不会被弹窗拦截）
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

  // [鲁棒性] 鼠标移离顶栏导航区，关闭切店/清屏可能残留的 hover 浮层，
  // 确保 findNavByText 命中真正的顶栏导航项（排除浮层内同名文本副本）。
  try { await mouseMove(fxgConn.send, 5, 5); } catch (e) {}
  await sleep(800);

  // [修入口-韧性] compass 店铺由服务端 session 决定（=上次在 compass 看过的店），
  // 切店后若立即开 compass 会读到"切前店"→ 静默污染（08-12 串店根因）。
  // 顶栏点击本身可用（已验证），但服务端上下文有滞后。故改为"开 compass → B1 校验店铺名；
  // 不符则关 compass、回 fxg 暖机（ensureBrand + 真实站内导航 + 等待，给服务端上下文
  // 时间追上目标店）、重开、再校验"，最多 MAX_COMPASS_RETRY 次。仍不符才终止（安全）。
  const MAX_COMPASS_RETRY = 3;

  // 暖机：确保 fxg 处于目标店，并做一次真实站内导航（商品列表/首页）作为"活动"，
  // 让服务端 compass 上下文有机会同步到目标店（run-all 中 step8/9 天然提供此暖机）。
  async function warmUpFxgAsShop(fxgConn, brand, waitMs) {
    try { await ensureBrand(fxgConn.send, brand); } catch (e) {}
    try { await fxgConn.send('Page.navigate', { url: 'https://fxg.jinritemai.com/ffa/g/list' }, 15000); } catch (e) {}
    await sleep(6000);
    try { await fxgConn.send('Page.navigate', { url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' }, 15000); } catch (e) {}
    await sleep(waitMs);
    try { await mouseMove(fxgConn.send, 5, 5); } catch (e) {}
    await sleep(500);
  }

  async function closeAllCompassTabs() {
    try {
      const ts = await httpGet('/json/list');
      const others = ts.filter(t => t.type === 'page' && t.url && t.url.includes('compass'));
      for (const t of others) { try { await httpPut('/json/close/' + t.id); } catch (e) {} }
    } catch (e) {}
  }

  // [切店入口兜底 2026-08-13] compass 前端切店（「切换数据视角」入口）。
  // ★★★ P0 风控约束（用户明确）★★★：
  //   ① 仅限兜底——只在"fxg 点击电商罗盘正常进入 → compass 店铺不正确（B1 拦截）"后才可使用；
  //   ② 使用前必须保证 compass 目标品牌 == 当前 fxg 所属品牌（先 ensureBrand 到 BRAND）；
  //   ③ 若目标品牌 ≠ fxg 当前品牌就强切 → 必触发站点风控 → 登录态被全部清除。
  // 语义：把 compass 从"陈旧的另一店"拉回"fxg 当前店"，绝不跨店乱切。
  async function trySwitchCompassViaView(compassConn, fxgConn, brand) {
    // —— 前置：fxg 必须已处于目标品牌（否则拒绝执行，防风控）——
    let fxgOk = false;
    try { fxgOk = await ensureBrand(fxgConn.send, brand); } catch (e) {}
    if (!fxgOk) {
      console.error('  [切店入口] fxg 未处于目标品牌 [' + brand + ']，拒绝执行「切换数据视角」（P0 风控约束）');
      return false;
    }
    console.log('  [切店入口] fxg 已确认处于 [' + brand + ']，尝试「切换数据视角」拉回 compass...');

    // 1) 点击 compass 顶栏品牌元素（userName 处）
    const nameJS = `(function(){
      var el=document.querySelector('[class*="userName"]');
      if(!el)return JSON.stringify({nf:1});
      var r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:(el.textContent||'').trim()});
    })()`;
    const nameR = JSON.parse(((await evalJS(compassConn.send, nameJS, 2))||{}).value || '{}');
    if (!nameR.x) { console.error('  [切店入口] 未找到 compass 顶栏品牌元素'); return false; }
    console.log('  [切店入口] 点击顶栏品牌 [' + nameR.text + '] @(' + nameR.x + ',' + nameR.y + ')');
    await clickAt(compassConn.send, nameR.x, nameR.y);
    await sleep(1500);

    // 2) 下拉菜单中点击「切换数据视角」（switchAccount 类 / 文本精确）
    const swJS = `(function(){
      var all=document.querySelectorAll('*');
      for(var i=0;i<all.length;i++){
        var e=all[i];var t=(e.textContent||'').trim();
        if(t==='切换数据视角'||(String(e.className||'').indexOf('switchAccount')>=0&&t.indexOf('切换')>=0)){
          var r=e.getBoundingClientRect();
          if(r.width>20&&r.width<400&&r.height>10&&r.height<80)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t.slice(0,30)});
        }
      }
      return JSON.stringify({nf:1});
    })()`;
    const swR = JSON.parse(((await evalJS(compassConn.send, swJS, 2))||{}).value || '{}');
    if (!swR.x) { console.error('  [切店入口] 未找到「切换数据视角」'); return false; }
    console.log('  [切店入口] 点击「切换数据视角」@(' + swR.x + ',' + swR.y + ')');
    await clickAt(compassConn.send, swR.x, swR.y);
    await sleep(2000);

    // 3) 等「请选择店铺」modal，找目标品牌子区域（index_roleItem）
    for (let w = 0; w < 8; w++) {
      const itemJS = `(function(){
        var BRAND=${JSON.stringify(brand)};
        var items=document.querySelectorAll('[class*="index_roleItem"]');
        for(var i=0;i<items.length;i++){
          var t=(items[i].textContent||'').trim();
          if(t.indexOf(BRAND)>=0){
            var r=items[i].getBoundingClientRect();
            if(r.width>50&&r.height>30)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t.slice(0,40)});
          }
        }
        return JSON.stringify({nf:1});
      })()`;
      const itemR = JSON.parse(((await evalJS(compassConn.send, itemJS, 2))||{}).value || '{}');
      if (itemR.x) {
        console.log('  [切店入口] 点击品牌 [' + itemR.text + '] @(' + itemR.x + ',' + itemR.y + ')');
        await clickAt(compassConn.send, itemR.x, itemR.y);
        await sleep(4000);
        // 4) 校验切换结果（页面可能 reload，重读店铺名）
        const afterJS = `(function(){
          var el=document.querySelector('[class*="userName"]');
          return JSON.stringify({userName:el?(el.textContent||'').trim():'',url:location.href.slice(0,80)});
        })()`;
        const afterR = JSON.parse(((await evalJS(compassConn.send, afterJS, 2))||{}).value || '{}');
        console.log('  [切店入口] 切换后 userName=[' + afterR.userName + '] url=' + afterR.url);
        if (afterR.userName && afterR.userName.indexOf(brand) >= 0) {
          console.log('  ✓ [切店入口] compass 已切换到 [' + brand + ']');
          return true;
        }
        console.error('  [切店入口] 切换后店铺未变为 [' + brand + ']（当前 [' + afterR.userName + ']）');
        return false;
      }
      await sleep(1000);
    }
    console.error('  [切店入口] 「请选择店铺」弹窗内未找到品牌 [' + brand + ']');
    return false;
  }

  let c = null;            // compass 连接
  let compShop = '';
  for (let cr = 0; cr <= MAX_COMPASS_RETRY && !c; cr++) {
    if (cr > 0) {
      console.log('\n[修入口-重试 ' + cr + '/' + MAX_COMPASS_RETRY + '] 回 fxg 暖机后重开 compass...');
      await closeAllCompassTabs();
      await warmUpFxgAsShop(fxgConn, BRAND, 8000 + cr * 7000);
    }

    // [M4] 点击顶部"电商罗盘"（findNavByText 文本定位 + 区域过滤）
    let dsPos = await findNavByText(fxgConn.send, '电商罗盘', { yMax: 80 });
    if (!dsPos) { console.log('  ⚠️ 未找到电商罗盘，暖机后重试'); continue; }
    console.log('[2/4] 点击"电商罗盘" @(' + dsPos.x + ',' + dsPos.y + ')');
    await clickAt(fxgConn.send, dsPos.x, dsPos.y);

    // 3. 等新标签（最多重试 3 次）
    console.log('\n[3/4] 等待 compass 标签...');
    let compass = null;
    for (let attempt = 0; attempt < 3 && !compass; attempt++) {
      if (attempt > 0) {
        console.log('  第' + (attempt+1) + '次重试：重新清屏 + 点击...');
        await forceClearFxgPage(fxgConn);
        try { await mouseMove(fxgConn.send, 5, 5); } catch (e) {}
        await sleep(1000);
        const retryPos = await findNavByText(fxgConn.send, '电商罗盘', { yMax: 80 });
        if (retryPos) {
          await clickAt(fxgConn.send, retryPos.x, retryPos.y);
        }
      }
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        targets = await httpGet('/json/list');
        for (const t of targets) {
          if (t.type === 'page' && t.url && t.url.includes('compass') && !fxgTabsBefore.has(t.id)) { compass = t; break; }
        }
        if (compass) break;
      }
    }
    // [URL 兜底] 顶栏点击 3 次都没开出 compass 标签时，直接开新标签导航。
    // 常见诱因：切店/品牌校验残留的 hover 浮层里有「电商罗盘」同名副本，
    // findNavByText 命中副本坐标（如 x≈326）→ 点了个假目标，永远等不到新标签。
    if (!compass) {
      console.log('  ⚠️ 点击未开出标签，改用 URL 直接导航兜底...');
      try {
        const nt = await httpPut('/json/new?' + encodeURIComponent('https://compass.jinritemai.com/shop'));
        if (nt && nt.id) {
          for (let i = 0; i < 15 && !compass; i++) {
            await sleep(1000);
            targets = await httpGet('/json/list');
            for (const t of targets) {
              if (t.type === 'page' && t.url && t.url.includes('compass') && t.id === nt.id) { compass = t; break; }
            }
          }
          if (compass) console.log('  ✓ URL 兜底成功');
        }
      } catch (e) { console.log('  URL 兜底失败: ' + e.message); }
    }
    if (!compass) { console.log('  ✗ 未开出 compass 标签'); continue; }

    // 4. 等中转 + 关弹窗
    await sleep(8000);
    c = await connectToTarget(compass.webSocketDebuggerUrl);
    await sleep(2000);
    console.log('  关弹窗...');
    await closePopups(c);

    // [B1 防污染] 校验 compass 页面店铺名 == BRAND，不符即重试暖机（服务端上下文滞后）。
    console.log('\n[防污染] 校验 compass 当前店铺名...');
    compShop = await readCompassBrand(c.send);
    if (compShop && compShop.indexOf(BRAND) >= 0) {
      console.log('  ✓ compass 店铺名校验通过：' + compShop);
      break;
    } else {
      console.error('  ✗ compass 当前店铺 [' + compShop + '] ≠ 目标 [' + BRAND + ']（服务端上下文未同步）');
      // [切店入口兜底 2026-08-13] B1 失败时，尝试「切换数据视角」把 compass 拉回目标店。
      // P0 风控约束（用户明确）：仅 B1 失败后可用的兜底手段；且必须先 ensureBrand 使
      // fxg 处于目标品牌（函数内强制检查，fxg 非目标店则拒绝执行防风控）。
      // 若入口失败，才退化为暖机重试（关 compass → fxg 站内活动 → 重开再校验）。
      const switched = await trySwitchCompassViaView(c, fxgConn, BRAND);
      if (switched) {
        // 切换后页面可能已 reload，重新读取店铺名校验
        try { c.close(); } catch (e) {}
        c = null;
        const ts2 = await httpGet('/json/list');
        const comp2 = ts2.find(t => t.type === 'page' && t.url && t.url.includes('compass'));
        if (comp2) {
          c = await connectToTarget(comp2.webSocketDebuggerUrl);
          await sleep(3000);
          compShop = await readCompassBrand(c.send);
          if (compShop && compShop.indexOf(BRAND) >= 0) {
            console.log('  ✓ 切店入口生效，compass 店铺名校验通过：' + compShop);
            break;
          }
          console.error('  ✗ 切店入口后店铺仍不正确 [' + compShop + ']');
          try { c.close(); } catch (e) {}
          c = null;
        } else {
          console.error('  ✗ 切店入口后未找到 compass 标签');
          c = null;
        }
      } else {
        console.error('  ✗ 切店入口失败，准备暖机重试');
        try { c.close(); } catch (e) {}
        c = null;
      }
    }
  }

  fxgConn.close();
  if (!c) {
    console.error('✗ 多次重试仍无法在 compass 打开正确店铺 [' + BRAND + ']，终止以防跨店污染');
    process.exit(1);
  }

  // 5. 三个子任务
  // [补跑支持] STEP6_ONLY=交易 或 STEP6_ONLY=商品,达人 → 只跑指定子任务。
  // 用于单项失败时定向补跑，避免重复下载已成功的项（下载配额/耗时）。
  const onlyRaw = (process.env.STEP6_ONLY || '').trim();
  const onlySet = onlyRaw ? new Set(onlyRaw.split(/[,，\s]+/).filter(Boolean)) : null;
  const activeTasks = onlySet ? SUBTASKS.filter(t => onlySet.has(t.name)) : SUBTASKS;
  if (onlySet) {
    console.log('\n  [STEP6_ONLY] 仅执行子任务: ' + activeTasks.map(t => t.name).join('/') +
      (activeTasks.length ? '' : ' (无匹配，请检查取值：商品/达人/交易)'));
  }

  const results = [];
  for (let taskIdx = 0; taskIdx < activeTasks.length; taskIdx++) {
    const task = activeTasks[taskIdx];
    console.log('\n[4/4] 子任务 ' + (taskIdx + 1) + '/' + activeTasks.length + ': ' + task.name);

    // 5.1 点击顶部导航（按文本定位，硬编码坐标兜底 —— R4）
    console.log('  点击"' + task.name + '"...');
    await clickNav(c.send, task.name, task.navX, task.navY, { yMax: 120 });
    await sleep(5000);
    await closePopups(c);

    // 5.2 达人需要额外点击"合作达人" sub-tab（同样文本优先，坐标兜底）
    if (task.needSubTab) {
      console.log('  点击"' + task.needSubTab.name + '" sub-tab...');
      await clickNav(c.send, task.needSubTab.name, task.needSubTab.x, task.needSubTab.y, { yMax: 320 });
      await sleep(5000);
      await closePopups(c);
    }

    // 5.3 找下载按钮位置（如果未预设），不行则刷新重试
    let btnX = task.downloadBtnX, btnY = task.downloadBtnY;
    if (!btnX) {
      for (let findTry = 0; findTry < 4; findTry++) {
        const btn = await findDownloadBtn(c.send);
        if (btn.x) { btnX = btn.x; btnY = btn.y; break; }
        if (findTry < 3) {
          console.log('  未找到按钮，刷新页面重试 (try ' + (findTry+1) + '/3)...');
          try { await c.send('Page.reload', { ignoreCache: false }, 15000); } catch(e) {}
          await sleep(10000);
          await closePopups(c);
        }
      }
      if (!btnX) {
        console.log('  ✗ 未找到"下载明细"按钮');
        results.push({ task: task.name, status: 'failed', reason: 'no download button' });
        continue;
      }
    }
    console.log('  下载按钮 @(' + btnX + ',' + btnY + ')');

    // 5.4 点击"近1天" + 读日期
    console.log('  点击"近1天"...');
    const near1Clicked = await clickNear1Day(c.send);
    if (!near1Clicked) { results.push({ task: task.name, status: 'failed', reason: 'no near1day' }); continue; }
    // 数据日期统一使用运行时前一天（不是页面显示的日期）
    const dataDate = readYesterdayDate();
    console.log('  数据日期:', dataDate);

    // 5.5 hover 下载明细（微动触发 hover 事件，增加等待确保下拉菜单渲染）
    console.log('  hover"下载明细"...');
    await mouseMove(c.send, btnX, btnY);
    await sleep(600);
    // 微动鼠标以触发完整的 hover 事件链
    await mouseMove(c.send, btnX + 3, btnY + 1);
    await sleep(1500);

    // 公共下载目录与归档路径
    const userDir = process.env.USERPROFILE || process.env.HOME || require('os').homedir();
    const downloadDir = path.join(userDir, 'Downloads');
    const fileName = dataDate + '_' + BRAND + '_' + task.fileSuffix + '.xlsx';
    const destFolder = path.join(PROJECT_DIR, dataDate);
    if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
    const destPath = path.join(destFolder, fileName);

    // [归属校验] 本子任务开始时刻（留 3s 余量）：早于此刻落盘的文件一律不认，
    // 配合 nameKeys 关键词校验，双重防止上一子任务迟到文件被误归档（2026-07-30/31 串档 bug）
    const nameKeys = task.nameKeys || [];
    const dlStartTs = Date.now() - 3000;
    const skipLogged = new Set();
    async function waitForDownload(sec) {
      for (let waitI = 0; waitI < sec; waitI++) {
        await sleep(1000);
        try {
          const files = fs.readdirSync(downloadDir)
            .filter(f => f.endsWith('.xlsx') || f.endsWith('.xls') || f.endsWith('.csv'))
            .map(f => ({ f, t: fs.statSync(path.join(downloadDir, f)).mtime.getTime() }))
            .sort((a, b) => b.t - a.t);
          for (const it of files) {
            if (it.t < dlStartTs) break;                      // 早于本子任务开始 → 非本次产物
            if ((Date.now() - it.t) / 1000 >= 30) break;
            if (nameKeys.length && !nameKeys.some(k => it.f.includes(k))) {
              if (!skipLogged.has(it.f)) {
                skipLogged.add(it.f);
                console.log('  ⏭ 跳过非本任务文件(归属校验): ' + it.f);
              }
              continue;
            }
            console.log('  找到下载: ' + it.f + ' (' + ((Date.now() - it.t) / 1000).toFixed(0) + 's ago)');
            return path.join(downloadDir, it.f);
          }
        } catch (e) {}
      }
      return null;
    }

    let foundFile = null;

    // [交易下载修复] 交易页「下载明细」是下拉触发器(ecom-dropdown-trigger)，
    // 直接点不会下载；必须 hover 展开下拉 → 对「下载当前明细」子项做 DOM 直点。
    // domClickByText 绕开屏幕坐标，对离屏 fixed 浮层同样生效（2026-07-23 轮3 已验证）。
    if (task.useDropdown) {
      const dropItem = task.dropdownItem || '下载当前明细';
      console.log('  [dropdown 模式] 展开下拉 + DOM 直点"' + dropItem + '"...');
      for (let d = 0; d < 3 && !foundFile; d++) {
        if (d > 0) {
          console.log('  重试 ' + d + '：先移开再重新 hover 展开下拉...');
          try { await mouseMove(c.send, 5, 5); } catch (e) {}
          await sleep(400);
          try { await mouseMove(c.send, btnX, btnY); } catch (e) {}
          await sleep(700);
          try { await mouseMove(c.send, btnX + 3, btnY + 1); } catch (e) {}
          await sleep(1200);
        }
        const ok = await domClickByText(c.send, dropItem);
        console.log('  DOM 直点"' + dropItem + '": ' + (ok ? '已触发' : '未命中，重试'));
        foundFile = await waitForDownload(30);
      }
      if (!foundFile) console.log('  ⚠️ dropdown 模式未触发下载，回退通用直点兜底...');
    }

    // 通用主路径（商品/达人 直点按钮；或 dropdown 模式失败后的兜底）
    if (!foundFile) {
      // 5.7 主路径：直接点击"下载明细"按钮
      console.log('  直接点击"下载明细"按钮 @(' + btnX + ',' + btnY + ')...');
      await clickAt(c.send, btnX, btnY);
      foundFile = await waitForDownload(35);

      // 兜底：主路径未出文件时，尝试 hover 出"下载当前明细"下拉项（兼容旧逻辑）
      if (!foundFile) {
        console.log('  ⚠️ 主路径未触发下载，尝试 hover 下拉兜底...');
        // [P0-fix] 兜底前先关掉可能挡住下载区的引导/提示浮层，确保 hover 能展开下拉
        await closePopups(c);
        await mouseMove(c.send, btnX, btnY);
        await sleep(600);
        await mouseMove(c.send, btnX + 3, btnY + 1);
        await sleep(1500);
        let dropClicked = await triggerDownload(c.send, c, [], btnX, btnY);
        if (!dropClicked) {
          const closeTipJS = `(function(){
            var all=document.querySelectorAll('*');
            for(var i=0;i<all.length;i++){
              var e=all[i]; var t=(e.textContent||'').trim();
              if((t==='×'||t==='关闭'||t==='知道了'||t==='我知道了')&&e.children.length===0){
                var r=e.getBoundingClientRect();
                if(r.width>5&&r.height>5) return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t});
              }
            }
            return JSON.stringify({nf:1});
          })()`;
          const closeBtn = JSON.parse(((await evalJS(c.send, closeTipJS, 2)) || {}).value || '{}');
          if (closeBtn.x) {
            console.log('  关闭引导提示: ' + closeBtn.text);
            await clickAt(c.send, closeBtn.x, closeBtn.y);
            await sleep(1000);
            await mouseMove(c.send, btnX, btnY);
            await sleep(1500);
            dropClicked = await triggerDownload(c.send, c, [], btnX, btnY);
          }
          if (!dropClicked) {
            console.log('  兜底：再次直接点击"下载明细"...');
            await clickAt(c.send, btnX, btnY);
            await sleep(3000);
          }
        }
        foundFile = await waitForDownload(35);
      }
    }

    // 5.8 归档
    if (foundFile) {
      fs.copyFileSync(foundFile, destPath);
      fs.unlinkSync(foundFile);
      console.log('  ✓ 归档: ' + destPath);
      results.push({ task: task.name, status: 'ok', file: destPath, date: dataDate });
    } else {
      console.log('  ✗ 未找到下载文件');
      results.push({ task: task.name, status: 'failed', reason: 'no file' });
    }
  }

  // 6. 关闭非 fxg 标签
  console.log('\n关闭非 fxg 标签...');
  try {
    targets = await httpGet('/json/list');
    const others = targets.filter(t => t.type === 'page' && t.url && !t.url.includes('chrome://') && !t.url.includes('fxg.jinritemai.com'));
    if (others.length > 0) {
      const ver = await httpGet('/json/version');
      const ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise((r, rej) => {
        ws.addEventListener('open', () => {
          let n = 0;
          for (const t of others) ws.send(JSON.stringify({ id: ++n, method: 'Target.closeTarget', params: { targetId: t.id } }));
          setTimeout(() => { try { ws.close(); } catch (e) {} r(); }, 1500);
        }, { once: true });
        ws.addEventListener('error', () => r());
      });
    }
  } catch (e) {}

  c.close();

  // 汇总
  console.log('\n' + '='.repeat(50));
  console.log('  执行汇总');
  console.log('='.repeat(50));
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : '✗';
    console.log('  ' + icon + ' ' + r.task + (r.file ? ' → ' + r.file : ' (失败: ' + r.reason + ')'));
  }

  const allOk = results.every(r => r.status === 'ok');
  console.log('\n' + (allOk ? '✅ 全部完成！' : '⚠ 部分失败'));
  process.exit(allOk ? 0 : 1);
}

main().catch(async e => {
  console.error('FATAL:', e && e.message); console.error(e.stack);
  try { await require('./fail-capture.cjs').captureOnFail('step6-' + (process.env.DOUDIAN_BRAND || ''), e && e.message); } catch (_) {}
  process.exit(1);
});
