// run-all.cjs — 抖店后台自动化 · 全流程主控脚本（支持双店铺）
// ====================================================================
// 依次执行：
//   第一步: open-chrome-doudian.sh  → 打开 Chrome + 进入抖店
//   第二+三步: doudian-login-and-enter.mjs → 登录 + 选店（可选）
//   --- 店铺1（DD_SHOP_A）---
//   第四步: step4-export.cjs → 商品管理导出
//   第五步: step5-yujing.cjs → 精选联盟看数据
//   第六步: step6-compass.cjs → 电商罗盘导出
//   --- 切换店铺 ---
//   第七步: step7-switch-shop.cjs → 切换至店铺2
//   --- 店铺2（DD_SHOP_B）---
//   第八步: step4-export.cjs → 商品管理导出
//   第九步: step5-yujing.cjs → 精选联盟看数据
//   第十步: step6-compass.cjs → 电商罗盘导出
//   --- 合并报表 ---
//   第十一步: step9-build-report.cjs → 合并 5-sheet 日报
//
// 用法:
//   DOUDIAN_EMAIL=xxx DOUDIAN_PASSWORD=xxx node run-all.cjs
//   node run-all.cjs --skip=login        # 跳过登录
//   node run-all.cjs --skip=step4        # 跳过第四步
//   node run-all.cjs --skip=second       # 跳过第二个店铺
//   node run-all.cjs --fresh             # 清空当天检查点，强制全流程重采
//
// 断点续跑: state/YYYY-MM-DD.json 记录当天已成功步骤(step4~step11)，
//           崩溃/重跑时自动跳过已完成步骤；chrome/login 每次都重新确认。
// 容错:     第七步切换失败不再阻断全流程，仅跳过店铺2采集，仍执行合并。
//
// 退出码: 0=全部成功; 1=某一步失败
// ====================================================================

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// =================== 配置 ===================
// 全部支持环境变量覆盖（见 SKILL.md「环境与路径配置」）。
// DD_SHOP_A / DD_SHOP_B = 两个店铺名（运行时必填，此处仅占位）。
const PROJECT_DIR = path.join(__dirname, '..');
const NODE = process.env.DD_NODE || 'node';
const BASH = 'bash';

const SHOP1 = process.env.DD_SHOP_A || '店铺A';
const SHOP2 = process.env.DD_SHOP_B || '店铺B';

const STEPS = [
  {
    name: '第一步：打开Chrome + 进入抖店后台',
    command: BASH,
    args: [path.join(PROJECT_DIR, 'open-chrome-doudian.sh')],
    env: {},
    timeout: 120000,
  },
  {
    name: '第二+三步：登录 + 选店进后台',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'doudian-login-and-enter.mjs')],
    env: { DOUDIAN_EMAIL: process.env.DOUDIAN_EMAIL, DOUDIAN_PASSWORD: process.env.DOUDIAN_PASSWORD },
    timeout: 60000,
    required: false,
    skipKey: 'login',
    retryCodes: [2],
    maxRetries: 2,
  },
  // === 店铺1 ===
  {
    name: '第四步·店铺1：商品管理导出',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step4-export.cjs')],
    env: { DOUDIAN_BRAND: SHOP1 },
    timeout: 300000,
    skipKey: 'step4',
    retryCodes: [1],
    maxRetries: 1,
  },
  {
    name: '第五步·店铺1：精选联盟看数据',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step5-yujing.cjs')],
    env: { DOUDIAN_BRAND: SHOP1 },
    timeout: 300000,
    skipKey: 'step5',
    retryCodes: [1],
    maxRetries: 1,
  },
  {
    name: '第六步·店铺1：电商罗盘导出',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step6-compass.cjs')],
    env: { DOUDIAN_BRAND: SHOP1 },
    timeout: 480000, // [2026-07-28] 3子任务+达人失败兜底可超5min，被SIGTERM杀→-1
    skipKey: 'step6',
    retryCodes: [1],
    maxRetries: 1,
  },
  // === 切换 ===
  {
    name: '第七步：切换店铺',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step7-switch-shop.cjs')],
    env: {},
    timeout: 180000,
    skipKey: 'step7',
    retryCodes: [1],
    maxRetries: 1,
    // 切换失败不再硬阻断全流程（去掉 critical）：仅跳过店铺2三步采集，
    // 避免把店铺1数据错存成店铺2（污染另有各步内部 ensureBrand 兜底）；
    // 但仍执行第十一步合并，保住店铺1已采集的数据。
    skipOnFail: ['step8', 'step9', 'step10'],
  },
  // === 店铺2 ===
  {
    name: '第八步·店铺2：商品管理导出',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step4-export.cjs')],
    env: { DOUDIAN_BRAND: SHOP2 },
    timeout: 300000,
    skipKey: 'step8',
    retryCodes: [1],
    maxRetries: 1,
  },
  {
    name: '第九步·店铺2：精选联盟看数据',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step5-yujing.cjs')],
    env: { DOUDIAN_BRAND: SHOP2 },
    timeout: 300000,
    skipKey: 'step9',
    retryCodes: [1],
    maxRetries: 1,
  },
  {
    name: '第十步·店铺2：电商罗盘导出',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step6-compass.cjs')],
    env: { DOUDIAN_BRAND: SHOP2 },
    timeout: 480000, // [2026-07-28] 同上
    skipKey: 'step10',
    retryCodes: [1],
    maxRetries: 1,
  },
  {
    name: '第十一步：合并双品牌日常报表',
    command: NODE,
    args: [path.join(PROJECT_DIR, 'step9-build-report.cjs')],
    env: {},
    timeout: 60000,
    skipKey: 'step11',
  },
];

// =================== 检查点（断点续跑） ===================
// state/YYYY-MM-DD.json 记录当天已成功的步骤（skipKey）。
// 重跑时自动跳过已完成步骤；chrome/login 幂等、不纳入检查点，每次都重新确认。
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const STATE_DIR = path.join(PROJECT_DIR, 'state');
const STATE_FILE = path.join(STATE_DIR, `${todayStr()}.json`);

// 是否参与检查点续跑：有 skipKey 且不是 login（登录态可能失效，每次都重登）
function isCheckpointStep(step) {
  return !!step.skipKey && step.skipKey !== 'login';
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { date: todayStr(), completed: [], updatedAt: null }; }
}
function saveState(state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('  ⚠ 检查点写入失败: ' + e.message); }
}

// =================== 参数解析 ===================
const args = process.argv.slice(2);
const skipSet = new Set();
let shopArg = '';
let fresh = false;

for (const a of args) {
  if (a.startsWith('--skip=')) {
    skipSet.add(a.split('=')[1]);
  } else if (a.startsWith('--shop=')) {
    shopArg = a;
  } else if (a === '--fresh') {
    fresh = true;  // 清空当天检查点，强制全流程重采
  }
}

// --skip=second 跳过所有店铺2步骤
if (skipSet.has('second')) {
  skipSet.add('step7');
  skipSet.add('step8');
  skipSet.add('step9');
  skipSet.add('step10');
}

// =================== 工具函数 ===================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function runStep(step, attempt) {
  const label = attempt > 1 ? `${step.name} [重试 ${attempt}/${step.maxRetries || 1}]` : step.name;
  console.log('\n' + '='.repeat(60));
  console.log(`  ${label}`);
  console.log('='.repeat(60));

  const env = { ...process.env, ...step.env };
  const stepArgs = [...step.args];
  if (shopArg) stepArgs.push(shopArg);

  return new Promise((resolve) => {
    const child = spawn(step.command, stepArgs, {
      cwd: PROJECT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: step.timeout,
    });

    child.stdout.on('data', (data) => process.stdout.write(data.toString()));
    child.stderr.on('data', (data) => process.stderr.write(data.toString()));

    child.on('close', (code) => resolve({ code: code ?? -1 }));

    child.on('error', (err) => {
      console.error(`  ✗ 启动失败: ${err.message}`);
      resolve({ code: -1 });
    });
  });
}

// =================== 主流程 ===================
async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     抖店后台自动化 · 双店铺全流程                    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  店铺1: ${SHOP1}`);
  console.log(`  店铺2: ${SHOP2}`);
  console.log(`  跳过: ${[...skipSet].join(', ') || '无'}`);
  console.log('');

  // 检查点：加载当天已完成步骤（--fresh 则清空重来）
  const state = fresh ? { date: todayStr(), completed: [], updatedAt: null } : loadState();
  if (fresh) { saveState(state); console.log('  (--fresh) 已清空当天检查点，全流程重采\n'); }
  const resumeSet = new Set(state.completed || []);
  if (resumeSet.size) console.log(`  🔖 断点续跑：已完成 ${[...resumeSet].join(', ')}（将自动跳过）\n`);

  const results = [];
  let overallSuccess = true;

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];

    // 手动 --skip 或 检查点已完成 → 跳过
    const doneByCheckpoint = isCheckpointStep(step) && resumeSet.has(step.skipKey);
    if ((step.skipKey && skipSet.has(step.skipKey)) || doneByCheckpoint) {
      const why = doneByCheckpoint && !skipSet.has(step.skipKey) ? ' （检查点已完成）' : '';
      console.log(`\n[${i + 1}/${STEPS.length}] ⏭  ${step.name}${why}`);
      results.push({ step: step.name, status: 'skipped' });
      continue;
    }

    let success = false;
    let attempt = 0;
    const maxAttempts = (step.maxRetries || 0) + 1;

    do {
      attempt++;
      const result = await runStep(step, attempt);

      if (result.code === 0) {
        success = true;
        results.push({ step: step.name, status: 'ok', attempts: attempt });
        console.log(`\n  ✅ ${step.name} — 成功`);
        // 写检查点
        if (isCheckpointStep(step) && !resumeSet.has(step.skipKey)) {
          resumeSet.add(step.skipKey);
          state.completed = [...resumeSet];
          saveState(state);
        }
        break;
      }

      const isRetryable = step.retryCodes && step.retryCodes.includes(result.code);
      if (isRetryable && attempt < maxAttempts) {
        console.log(`\n  ⚠ 退出码 ${result.code}，3秒后重试...`);
        await sleep(3000);
        continue;
      }

      console.log(`\n  ✗ ${step.name} — 失败 (退出码 ${result.code})`);
      results.push({ step: step.name, status: 'failed', code: result.code, attempts: attempt });

      if (step.required !== false) overallSuccess = false;
      break;
    } while (attempt < maxAttempts && !success);

    // 失败处理：
    //  - 若定义了 skipOnFail（如 step7 切换失败）→ 跳过指定的后续步骤（店铺2采集），
    //    但不中断整条流水线，仍会执行第十一步合并，保住店铺1已采集数据。
    //  - 其它步骤失败 → 容错继续。
    if (!success) {
      if (step.skipOnFail && step.skipOnFail.length) {
        for (const k of step.skipOnFail) skipSet.add(k);
        console.log(`\n⚠ ${step.name} 失败 → 跳过 ${step.skipOnFail.join('/')}（店铺2采集），仍执行后续合并。`);
      } else {
        console.log('\n⚠ 步骤失败，继续后续流程（容错模式）。');
      }
    }

    if (i < STEPS.length - 1) await sleep(2000);
  }

  // 汇总
  console.log('\n' + '='.repeat(60));
  console.log('  执行汇总');
  console.log('='.repeat(60));
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'skipped' ? '⏭' : '✗';
    const detail = r.status === 'ok' ? (r.attempts > 1 ? ` (${r.attempts}次)` : '') :
                   r.status === 'failed' ? ` (退出码 ${r.code})` : '';
    console.log(`  ${icon} ${r.step}${detail}`);
  }

  // 产出文件
  console.log('\n' + '='.repeat(60));
  console.log('  产出文件');
  console.log('='.repeat(60));
  const dateDirs = fs.readdirSync(PROJECT_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of dateDirs.slice(0, 10)) {
    const dirPath = path.join(PROJECT_DIR, d);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.xlsx'));
    for (const f of files) {
      const stat = fs.statSync(path.join(dirPath, f));
      console.log(`  📊 ${d}/${f}  (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }

  console.log('\n' + (overallSuccess ? '✅ 全部完成！' : '⚠ 部分失败'));
  process.exit(overallSuccess ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e && e.message); process.exit(1); });
