#!/usr/bin/env node
/**
 * open-chrome-doudian.mjs
 * ---------------------------------------------------------------
 * 一键打开「带远程调试端口 9222」的 Chrome，并进入抖店后台界面。
 *
 * 设计要点（已踩坑并固化）：
 * 1. 本机 Chrome 152 禁止在「默认用户资料目录」上开远程调试，
 *    必须用非默认 --user-data-dir。脚本使用 C:/tmp/chrome-debug
 *    （一份带登录态的调试资料副本）。
 * 2. 若 Chrome 已在运行且 9222 已响应，则直接复用（不杀进程），
 *    通过 CDP 激活已有的抖店标签页，没有则新建。
 * 3. 若未运行，则用调试资料目录启动并直接打开抖店后台 URL。
 * 4. 启动 URL 由命令行参数 --url 覆盖，默认抖店后台。
 *
 * 用法：
 *   node open-chrome-doudian.mjs
 *   node open-chrome-doudian.mjs --url https://fxg.jinritemai.com/index.html
 * ---------------------------------------------------------------
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import { createRequire } from 'module';
import { setTimeout as sleep } from 'timers/promises';

const require = createRequire(import.meta.url);

// ===== 可配置参数（均可用环境变量覆盖，见 SKILL.md） =====
const CHROME = process.env.DD_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const USER_DATA_DIR = process.env.DD_CHROME_USER_DATA || 'C:/tmp/chrome-debug';
const PORT = 9222;
const DEFAULT_URL = 'https://fxg.jinritemai.com/index.html';
const DOUDIAN_HOST = 'fxg.jinritemai.com';

// 解析命令行 --url
const urlArg = process.argv.slice(2).find((a) => a.startsWith('--url='));
const TARGET_URL = urlArg ? urlArg.split('=').slice(1).join('=') : DEFAULT_URL;

// ===== 工具函数 =====
function getWebSocketCtor() {
  if (global.WebSocket) return global.WebSocket;
  try { return require(process.env.DD_WS_PATH || 'ws'); }
  catch (e) { throw new Error('需要 Node >= 22（内置 WebSocket），或通过 DD_WS_PATH 指定 ws 模块路径'); }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('timeout')));
  });
}

async function waitPort(retries = 40, interval = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const v = await httpGet('/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) {
      /* 端口未就绪，继续等 */
    }
    await sleep(interval);
  }
  return null;
}

function connectBrowser(wsUrl) {
  const WS = getWebSocketCtor();
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onErr);
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onErr);
    setTimeout(() => reject(new Error('WS 连接超时')), 8000);
  });
}

function cdpSend(ws, method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6) + 1;
    const handler = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`CDP ${method} 超时`));
    }, 8000);
  });
}

// ===== 主流程 =====
async function main() {
  let version = await waitPort(1, 0); // 快速探测一次

  if (!version) {
    console.log('[1/4] 未检测到运行中的 Chrome，启动调试实例...');
    if (!fs.existsSync(USER_DATA_DIR)) {
      console.error(
        `✗ 调试资料目录不存在：${USER_DATA_DIR}\n` +
          `  请先用真实 Chrome 个人资料复制一份到该目录（约 5GB），再运行本脚本。`
      );
      process.exit(1);
    }
    const child = spawn(
      CHROME,
      ['--remote-debugging-port=' + PORT, '--user-data-dir=' + USER_DATA_DIR, '--no-first-run',
        '--window-size=1920,1080', '--force-device-scale-factor=1', '--high-dpi-support=1', TARGET_URL],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    version = await waitPort(40, 500);
    if (!version) {
      console.error('✗ Chrome 启动后 9222 端口仍未就绪，请检查是否被占用或 Chrome 路径是否正确。');
      process.exit(1);
    }
    console.log(`      ✓ Chrome 已启动，调试端口 ${PORT} 就绪 (${version.Browser})`);
  } else {
    console.log(`[1/4] 检测到已在运行的 Chrome (端口 ${PORT}, ${version.Browser})，直接复用。`);
  }

  console.log('[2/4] 连接 CDP 并定位抖店后台标签页...');
  const ws = await connectBrowser(version.webSocketDebuggerUrl);

  // 用 HTTP /json/list 获取页面列表（比 CDP Target.getTargets 更稳，规避 result 解析问题）
  const list = (await httpGet('/json/list')) || [];
  const pages = list.filter((t) => t.type === 'page');
  const doudian = pages.find((t) => t.url.includes(DOUDIAN_HOST));

  let targetId;
  if (doudian) {
    targetId = doudian.id;
    console.log('      ✓ 已有抖店标签页，激活并置前。');
    await cdpSend(ws, 'Target.activateTarget', { targetId });
  } else {
    console.log('      ✓ 新建抖店后台标签页...');
    const r = await cdpSend(ws, 'Target.createTarget', { url: TARGET_URL });
    targetId = r.result.targetId;
  }

  // [M1] 锁定视口与 DPR（消除坐标漂移共同根因）：对定位到的 target 设置标准设备度量
  try {
    const attach = await cdpSend(ws, 'Target.attachToTarget', { targetId, flatten: true });
    const sid = attach.result && attach.result.sessionId;
    if (sid) {
      await cdpSend(ws, 'Emulation.setDeviceMetricsOverride',
        { deviceScaleFactor: 1, width: 1920, height: 1080, mobile: false }, sid);
      console.log('      ✓ 已锁定视口 1920x1080 / DPR=1 (target ' + targetId.slice(0, 8) + ')');
    }
  } catch (e) {
    console.log('      ⚠ 锁定视口失败（非致命）: ' + (e.message || e));
  }

  console.log('[3/4] 等待页面加载并校验登录态...');
  await sleep(4000);
  const list2 = (await httpGet('/json/list')) || [];
  const cur = list2.find((t) => t.id === targetId);
  const url = cur ? cur.url : '';
  console.log('      当前页面:', url || '(未知)');

  if (url.includes('/login')) {
    console.log('\n⚠️  抖店后台需要登录：请在浏览器中手动登录一次。');
    console.log('    登录后会话会保存在调试资料中，下次运行本脚本即可直接进入后台。');
  } else if (url.includes(DOUDIAN_HOST)) {
    console.log('\n✅ 已成功进入抖店后台界面！');
  } else {
    console.log('\nℹ️  页面未跳转到抖店后台，请检查网络或 URL。当前:', url);
  }

  // [4/4] 收尾：仅保留抖店后台标签，关闭其余标签页，并做最终检查
  console.log('[4/4] 收尾：仅保留抖店后台标签，清理其余标签页...');
  const list3 = (await httpGet('/json/list')) || [];
  const allPages = list3.filter((t) => t.type === 'page');
  let closedCount = 0;
  for (const t of allPages) {
    if (!t.url.includes(DOUDIAN_HOST)) {
      await cdpSend(ws, 'Target.closeTarget', { targetId: t.targetId });
      closedCount++;
    }
  }
  if (closedCount > 0) console.log(`      已关闭 ${closedCount} 个非抖店标签`);
  else console.log('      无需清理，仅抖店后台标签存在');

  // 最终检查：列出剩余标签页
  const list4 = (await httpGet('/json/list')) || [];
  const remaining = list4.filter((t) => t.type === 'page');
  console.log('      最终剩余标签页:');
  for (const t of remaining) console.log('        -', t.url);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ 脚本执行失败:', e.message || e);
  process.exit(1);
});
