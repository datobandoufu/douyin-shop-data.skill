// brand-helper.cjs — 抖店店铺品牌校验与切换（被 step4/5/6/7 复用）
// ====================================================================
// 目的：彻底杜绝"页面停在错误店铺却把数据存成正确文件名"的污染问题。
//   - getCurrentBrand(send)        读取顶部当前品牌
//   - switchToBrand(send, target)  执行一次 hover→切换→选目标 的完整切换
//   - ensureBrand(send, target)    校验当前品牌，不匹配则切换并校验（带重试）
//
// 关键修复：findBrandInDialog 不再要求 e.children.length===0
//   —— 切换弹窗里的店铺项带图标子元素（children>0），原逻辑永远匹配不到
// ====================================================================

const WebSocket = global.WebSocket;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function evalJS(send, expr, retries = 4, cdpTimeout = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, timeout: cdpTimeout }, cdpTimeout + 3000);
      return r.result;
    } catch (e) {
      if (i < retries - 1) await sleep(800 + i * 200);
      else throw e;
    }
  }
}

// 派发输入事件：带重试 + 长超时（抖店页面常驻长任务，短超时易被卡掉）
async function dispatchWithRetry(send, method, params, tries = 2, perMs = 8000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await send(method, params, perMs); }
    catch (e) { lastErr = e; await sleep(600); }
  }
  throw lastErr || new Error('DISPATCH_FAIL:' + method);
}
async function clickAt(send, x, y) {
  await dispatchWithRetry(send, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await dispatchWithRetry(send, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function mouseMove(send, x, y) {
  await dispatchWithRetry(send, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}
// 把目标标签页提到前台并聚焦（非前台标签的 Input 事件会被节流/挂起）
async function bringToFront(send) {
  try { await send('Page.bringToFront', {}, 8000); } catch (e) {}
}
async function closePopups(send) {
  // [风控优化 2026-08-13] Escape 间加随机停顿，避免机械连发
  for (let i = 0; i < 2; i++) {
    try { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
    try { await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000); } catch (e) {}
    await sleep(200 + Math.floor(Math.random() * 300));
  }
}

// 店铺名来自环境变量（DD_SHOP_A / DD_SHOP_B），保证公开版不含具体品牌
const BRANDS = [process.env.DD_SHOP_A || '店铺A', process.env.DD_SHOP_B || '店铺B'];

async function getCurrentBrand(send) {
  const js = `(function(){
    var el=document.querySelector('.index_userName__16Isl')||document.querySelector('[class*="index_userName"]');
    return el?(el.textContent||'').trim():'';
  })()`;
  try { const r = await evalJS(send, js, 3); return (r && r.value || '').trim(); }
  catch (e) { return ''; }
}

async function findBrandNamePos(send) {
  // 匹配店铺名的前 3 字符（保持原逻辑：短关键词命中顶栏品牌文本）
  const keys = BRANDS.filter(Boolean).map(b => b.substring(0, 3));
  const js = `(function(){
    var keys=${JSON.stringify(keys)};
    var all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      var hit=false; for(var k=0;k<keys.length;k++){ if(keys[k]&&t.indexOf(keys[k])>=0){hit=true;break;} }
      if(hit&&e.children.length===0){
        var r=e.getBoundingClientRect();
        if(r.y<100&&r.x>800){ return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t}); }
      }
    }
    return JSON.stringify({nf:1});
  })()`;
  try { return JSON.parse((await evalJS(send, js, 3)).value || '{}'); } catch (e) { return {}; }
}

async function findSwitchText(send) {
  const js = `(function(){
    var all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      if(t.indexOf('切换')>=0&&t.indexOf('店铺')>=0&&t.length<20){
        var r=e.getBoundingClientRect();
        if(r.x>0&&r.y>0){
          var v=window.getComputedStyle(e).visibility, d=window.getComputedStyle(e).display;
          if(v!=='hidden'&&d!=='none'&&r.width>20&&r.height>10){
            return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:t});
          }
        }
      }
    }
    return JSON.stringify({nf:1});
  })()`;
  try { return JSON.parse((await evalJS(send, js, 3)).value || '{}'); } catch (e) { return {}; }
}

// 【已修复】不再要求 children.length===0；按文本匹配（允许带图标子元素）
async function findBrandInDialog(send, target) {
  const js = `(function(tgt){
    var all=document.querySelectorAll('*');
    var cands=[];
    for(var i=0;i<all.length;i++){
      var e=all[i]; var t=(e.textContent||'').trim();
      if(t && (t===tgt || t.indexOf(tgt)>=0) && t.length<=tgt.length+2){
        var r=e.getBoundingClientRect();
        if(r.x>200&&r.x<1800&&r.y>100&&r.y<900&&r.width>50&&r.height>10){
          cands.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height),text:t});
        }
      }
    }
    if(cands.length){ cands.sort(function(a,b){return b.y-a.y;}); return JSON.stringify(cands[0]); }
    return JSON.stringify({nf:1});
  })(${JSON.stringify(target)})`;
  try { return JSON.parse((await evalJS(send, js, 3)).value || '{}'); } catch (e) { return {}; }
}

// 执行一次完整切换：hover 品牌名 → 点击"切换组织/店铺" → 在弹窗中点目标品牌 → 刷新校验
async function switchToBrand(send, target) {
  await closePopups(send);
  await sleep(500);

  const pos = await findBrandNamePos(send);
  if (!pos.x) throw new Error('BRAND_POS_NOT_FOUND');

  await mouseMove(send, pos.x, pos.y);
  await sleep(1200);

  let sw = await findSwitchText(send);
  if (!sw.x) {
    await clickAt(send, pos.x, pos.y);
    await sleep(1200);
    sw = await findSwitchText(send);
  }
  if (!sw.x) throw new Error('SWITCH_TEXT_NOT_FOUND');

  await clickAt(send, sw.x, sw.y);

  // 弹窗内店铺列表为异步加载，点击后轮询等待目标品牌出现（最多 ~10s），
  // 避免 3000ms 时列表尚未渲染完毕而误报 TARGET_BRAND_NOT_IN_DIALOG。
  let targetPos = { nf: 1 };
  const tStart = Date.now();
  while (Date.now() - tStart < 10000) {
    targetPos = await findBrandInDialog(send, target);
    if (targetPos.x) break;
    await sleep(1000);
  }
  if (!targetPos.x) throw new Error('TARGET_BRAND_NOT_IN_DIALOG:' + target);

  await clickAt(send, targetPos.x, targetPos.y);
  await sleep(4000);
  await closePopups(send);

  // 刷新确保 SPA 路由初始化完毕
  try { await send('Page.reload', { ignoreCache: false }, 15000); } catch (e) {}
  await sleep(6000);
  await closePopups(send);

  // 校验侧边栏已加载
  for (let w = 0; w < 5; w++) {
    try {
      const sb = await evalJS(send, `(function(){var e=document.querySelector('[class*="menu"] a,[class*="sidebar"] a,a[href*="g/list"]');return e?e.textContent.trim():'';})()`, 2);
      if (sb && sb.value) break;
    } catch (e) {}
    await sleep(1500);
  }

  // [鲁棒性] 切店结尾把鼠标移开顶栏导航区，关闭可能残留的 hover 浮层，
  // 避免后续 findNavByText（电商罗盘等）命中浮层内的同名文本（如 @326,32 偏移项）。
  try { await mouseMove(send, 5, 5); } catch (e) {}
  await sleep(800);

  return await getCurrentBrand(send);
}

// [修复 2026-07-28] fxg 基准标签可能被上一步（如 step5 失败）带离首页（如停在
// alliance/common/redirectBuyin），此时顶栏品牌元素不存在 → getCurrentBrand 返回空、
// switchToBrand 报 BRAND_POS_NOT_FOUND。兜底：导航回抖店首页再校验。
async function gotoHomepage(send) {
  try { await send('Page.navigate', { url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' }, 15000); } catch (e) {}
  await sleep(8000);
  await closePopups(send);
}

// 确保当前品牌 == target；不匹配则切换并校验（带重试）。返回 true/false
async function ensureBrand(send, target, opts = {}) {
  const maxTry = opts.maxTry || 2;
  let cur = await getCurrentBrand(send);
  if (!cur) {
    console.log('  [品牌校验] 品牌为空（基准页可能不在首页），导航回抖店首页...');
    await gotoHomepage(send);
    cur = await getCurrentBrand(send);
  }
  console.log('  [品牌校验] 当前: ' + (cur || '(空)') + ' / 目标: ' + target);
  if (cur === target) {
    console.log('  [品牌校验] 已是目标品牌 ✓');
    return true;
  }
  for (let i = 0; i < maxTry; i++) {
    console.log('  [品牌校验] 不匹配，尝试切换 (' + (i + 1) + '/' + maxTry + ')...');
    const nb = await switchToBrand(send, target).catch(e => { console.log('  [品牌校验] 切换异常: ' + e.message); return ''; });
    if (nb === target) { console.log('  [品牌校验] 切换成功 ✓'); return true; }
    await sleep(2000);
  }
  const final = await getCurrentBrand(send);
  if (final === target) return true;
  console.log('  [品牌校验] 切换失败，当前仍为: ' + (final || '(空)'));
  return false;
}

module.exports = { getCurrentBrand, switchToBrand, ensureBrand, findBrandInDialog, findBrandNamePos, findSwitchText, gotoHomepage, BRANDS, closePopups, bringToFront };
