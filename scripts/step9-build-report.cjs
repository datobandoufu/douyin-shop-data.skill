// step9-build-report.cjs — 第九步：合并双品牌日常报表（5 sheet）
// ====================================================================
// 从各源文件中读取数据，按规则生成 5-sheet 的日常报表：
//   Sheet1: 佣金数据 (from 日常报表.xlsx)
//   Sheet2: 成交概览 (from 交易明细.xlsx, 载体类型=全部, 投放时段=不限)
//         仅保留: 日期/载体类型/投放时段/成交金额/用户支付金额/智能优惠券金额/
//                 平台补贴金额/达人补贴金额
//   Sheet3: 自营成交 (from 交易明细.xlsx, 投放时段=不限, 同上列)
//   Sheet4: 商品列表 (from 商品列表.xlsx)
//   Sheet5: 达人列表 (from 达人列表.xlsx)
// ====================================================================

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = path.join(__dirname, '..');
const PYTHON = process.env.DD_PYTHON || 'python';
const BRANDS = [process.env.DD_SHOP_A || '店铺A', process.env.DD_SHOP_B || '店铺B'];

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getDayBefore(n = 1) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let date = getYesterday();
let BASE = path.join(PROJECT_DIR, date);
// fallback: 如果昨天目录下没有日报，尝试前天
const yujingFiles = BRANDS.map(b => path.join(BASE, `${date}_${b}_日常报表.xlsx`));
if (!yujingFiles.some(f => fs.existsSync(f))) {
  date = getDayBefore(2);
  const altBase = path.join(PROJECT_DIR, date);
  const altFiles = BRANDS.map(b => path.join(altBase, `${date}_${b}_日常报表.xlsx`));
  if (altFiles.some(f => fs.existsSync(f))) {
    BASE = altBase;
    console.log(`  [注] 昨天(${getYesterday()})无日报，回落至 ${date}`);
  }
}

// 生成 Python 合并脚本
const pyScript = `import pandas as pd, os, re, time, warnings, gc
warnings.filterwarnings('ignore')
BASE = r"${BASE.replace(/\\/g, '/')}"
# [精度保护] 纯数字长ID（商品编码/商品ID/达人ID 等）必须按文本读写，
# 否则 pandas→openpyxl 写成数值后 Excel 仅15位精度，19位ID尾数被截断变科学计数。
ID_KEYS = ('ID', 'id', '编码', 'ID号', '编号', '货号')
LONG_DIGIT_RE = re.compile(r'^\\d{12,}$')
def _is_long_digit(v):
    return isinstance(v, str) and bool(LONG_DIGIT_RE.match(v.strip()))
def text_cols_for(df):
    # 命中规则(二选一即视为长ID，必须按文本处理，否则 Excel 仅15位精度会丢尾数)：
    #  1) 列名含 ID/编码/编号/货号 等关键词
    #  2) 该列 >=80% 单元格是「12位以上纯数字」(抗改名/抗新增ID列，不会静默失效)
    res = set()
    for c in df.columns:
        if any(k in str(c) for k in ID_KEYS):
            res.add(c); continue
        s = df[c].dropna()
        if len(s) == 0:
            continue
        if sum(_is_long_digit(str(x)) for x in s) / len(s) >= 0.8:
            res.add(c)
    return res
def keep_str(f, sheet):
    # [2026-08-13 修复] 用显式 open 句柄读取并立即关闭，避免 pandas/openpyxl
    # 延迟释放文件句柄导致同进程内 os.replace 目标文件被占(WinError 5 自锁)。
    with open(f, 'rb') as _fh:
        df0 = pd.read_excel(_fh, sheet_name=sheet)
    cols = text_cols_for(df0)
    if cols:
        with open(f, 'rb') as _fh:
            df = pd.read_excel(_fh, sheet_name=sheet, dtype={c: str for c in cols})
        for c in cols:
            df[c] = df[c].astype(str).str.replace(r'\\.0$', '', regex=True).str.strip()
    else:
        df = df0
    return df
COLS = ['日期','载体类型','投放时段','成交金额','用户支付金额','智能优惠券金额','平台补贴金额','达人补贴金额']
BRANDS = ${JSON.stringify(BRANDS)}
for brand in BRANDS:
    yujing_f = os.path.join(BASE, f'${date}_{brand}_日常报表.xlsx')
    tmp_f = yujing_f.replace('.xlsx', '_tmp.xlsx')
    if not os.path.exists(yujing_f):
        print(f'  ⚠️ SKIP {brand}: 日常报表不存在（建议补跑 step5/step9 精选联盟），已跳过该店')
        continue
    trade_f = os.path.join(BASE, f'${date}_{brand}_交易明细.xlsx')
    goods_f = os.path.join(BASE, f'${date}_{brand}_商品列表.xlsx')
    talent_f = os.path.join(BASE, f'${date}_{brand}_达人列表.xlsx')
    print(f'\\n=== {brand} ===')
    # Sheet1: 佣金（核心，必须存在）
    if not os.path.exists(yujing_f):
        print(f'  ⚠️ SKIP: 日常报表源文件不存在（建议补跑 step5/step9 精选联盟）')
        continue
    # [2026-08-13 修复] 显式 open 句柄读取佣金源并立即关闭，避免 os.replace 自锁
    with open(yujing_f, 'rb') as _fh:
        df1 = pd.read_excel(_fh, sheet_name=0)
    print(f'  Sheet1 佣金: {len(df1)} rows')
    # Sheet2: 成交概览（缺文件则填空 df）
    if os.path.exists(trade_f):
        df_trade_gaikuang = pd.read_excel(trade_f, sheet_name='成交概览')
        df2 = df_trade_gaikuang[(df_trade_gaikuang['载体类型']=='全部')&(df_trade_gaikuang['投放时段']=='不限')][COLS]
    else:
        print(f'  ⚠️ Sheet2 成交概览: 源文件缺失（缺 {brand}_交易明细.xlsx，建议补跑 step6），留空')
        df2 = pd.DataFrame(columns=COLS)
    print(f'  Sheet2 成交概览: {len(df2)} rows')
    # Sheet3: 自营成交
    if os.path.exists(trade_f):
        df_trade_ziying = pd.read_excel(trade_f, sheet_name='自营成交')
        df3 = df_trade_ziying[df_trade_ziying['投放时段']=='不限'][COLS]
    else:
        print(f'  ⚠️ Sheet3 自营成交: 源文件缺失（缺 {brand}_交易明细.xlsx，建议补跑 step6），留空')
        df3 = pd.DataFrame(columns=COLS)
    print(f'  Sheet3 自营成交: {len(df3)} rows')
    # Sheet4: 商品列表
    if os.path.exists(goods_f):
        df4 = keep_str(goods_f, 0)
    else:
        print('  Sheet4 商品列表: 源文件缺失，留空')
        df4 = pd.DataFrame()
    print(f'  Sheet4 商品列表: {len(df4)} rows')
    # Sheet5: 达人列表（过滤掉成交商品为0的）
    if os.path.exists(talent_f):
        df5_raw = keep_str(talent_f, 0)
        n_before = len(df5_raw)
        if '成交商品' in df5_raw.columns:
            df5 = df5_raw[df5_raw['成交商品'] != 0]
            n_removed = n_before - len(df5)
            if n_removed > 0:
                print(f'  Sheet5 达人列表: {n_before}→{len(df5)} rows (移除{n_removed}条成交商品=0)')
            else:
                print(f'  Sheet5 达人列表: {len(df5)} rows')
        else:
            df5 = df5_raw
            print(f'  Sheet5 达人列表: {len(df5)} rows (无成交商品列，跳过过滤)')
    else:
        print('  Sheet5 达人列表: 源文件缺失，留空')
        df5 = pd.DataFrame()
    with pd.ExcelWriter(tmp_f, engine='openpyxl') as writer:
        df1.to_excel(writer, sheet_name='佣金数据', index=False)
        df2.to_excel(writer, sheet_name='成交概览', index=False)
        df3.to_excel(writer, sheet_name='自营成交', index=False)
        df4.to_excel(writer, sheet_name='商品列表', index=False)
        df5.to_excel(writer, sheet_name='达人列表', index=False)
    # [精度保护-双保险] 写完后扫描所有 sheet，把「关键词列」或「长数字列」单元格
    # 强制为文本格式(@)，防止 Excel 打开时把纯数字文本再转回数值导致精度丢失。
    import openpyxl, re as _re
    LD = _re.compile(r'^\\d{12,}$')
    wb = openpyxl.load_workbook(tmp_f)
    for ws in wb.worksheets:
        hdr = [c.value for c in ws[1]]
        for ci, h in enumerate(hdr, start=1):
            col_text = False
            if h and any(k in str(h) for k in ID_KEYS):
                col_text = True
            else:
                vals = [ws.cell(r, ci).value for r in range(2, min(ws.max_row, 200) + 1)]
                nn = [v for v in vals if v is not None]
                if nn and sum(isinstance(v, str) and bool(LD.match(str(v).strip())) for v in nn) / len(nn) >= 0.8:
                    col_text = True
            if col_text:
                for row in ws.iter_rows(min_row=2, min_col=ci, max_col=ci):
                    for cell in row:
                        if cell.value is not None:
                            cell.value = str(cell.value).replace('.0', '').strip()
                            cell.number_format = '@'
    wb.save(tmp_f)
    # [2026-08-13 修复] 释放所有源文件句柄(含 pandas 延迟 finalizer)，避免同进程内
    # os.replace 目标文件被自身句柄占用 → WinError 5 自锁。
    gc.collect()
    # [2026-08-13 修复] 目标文件可能被外部进程(预览/文件监视/杀毒)以共享模式短暂占用，
    # 导致 os.replace(MoveFileEx 需 FILE_SHARE_DELETE) 抛 WinError 5。
    # 策略：先试 os.replace；失败则退回「字节覆盖写」(open(target,'wb') 直接写入，
    # 要求占用方以共享模式打开——预览/Excel只读/杀毒均满足)，两种各重试若干次。
    _ok = False
    _last_err = None
    for _i in range(40):
        try:
            os.replace(tmp_f, yujing_f)
            _ok = True
            break
        except Exception as _e:
            _last_err = _e
            try:
                with open(tmp_f, 'rb') as _src, open(yujing_f, 'wb') as _dst:
                    _dst.write(_src.read())
                try:
                    os.remove(tmp_f)
                except Exception:
                    pass
                _ok = True
                break
            except Exception as _e2:
                _last_err = _e2
                time.sleep(0.5)
    if not _ok:
        raise RuntimeError('os.replace/覆盖 失败(文件被占用): ' + str(_last_err))
    print(f'  ✅ {yujing_f} ({os.path.getsize(yujing_f)/1024:.1f} KB)')
print('\\nDone!')
`;

const pyPath = path.join(process.env.DD_TMP_DIR || 'C:/tmp', 'build-report-' + Date.now() + '.py');
fs.writeFileSync(pyPath, pyScript);

try {
  execSync('"' + PYTHON + '" "' + pyPath + '"', {
    env: { ...process.env, PYTHONPATH: process.env.DD_PYTHONPATH || '' },
    stdio: 'inherit'
  });
  console.log('\n✅ 第九步完成！');
  process.exit(0);
} catch (e) {
  console.error('✗ 第九步失败:', e.message);
  process.exit(1);
} finally {
  try { fs.unlinkSync(pyPath); } catch(e) {}
}
