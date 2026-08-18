---
name: douyin-daily-report
description: "抖店（抖音电商）后台自动化日报流水线。驱动 Chrome CDP 登录抖店卖家后台（fxg.jinritemai.com），对双店铺依次导出商品/佣金/电商罗盘数据，切店后重复，最后合并为多 sheet Excel 日报。适用于：跑批、补跑单店、排障、迁移到新机器、双店铺流水线复刻。触发词：抖店日常报表、精选联盟佣金抓取、电商罗盘导出、双店铺流水线、douyin daily report、step5、step6、step7、step9。"
disable-model-invocation: true
---

# 抖店双店铺日常报表自动化

## 项目概览

端到端浏览器自动化流水线：通过 Chrome DevTools Protocol (CDP) 驱动抖店卖家后台，采集**两个店铺**的每日经营数据，合并为统一的多 sheet Excel 日报。

```
店铺A 商品导出 ─┐
店铺A 佣金采集 ─┤  step9 合并
店铺A 罗盘导出 ─┼──►  5-sheet 日报
店铺B 商品导出 ─┤
店铺B 佣金采集 ─┤
店铺B 罗盘导出 ─┘
```

本技能自带 `scripts/` 生产脚本（已脱敏，店铺名/路径全部可配置），`references/` 存放实战中沉淀的非显然 CDP 模式、顶栏 DOM 结构与完整踩坑记录。

## 适用场景

- 构建 / 运行 / 排障 / 定时调度抖店日报流水线
- 修复某一步失败（如 `NO_BUYIN_TAB`、`NOT_FOUND: 导出查询商品`、店铺切换失败）
- 把流水线迁移到新机器 / 新店铺组合
- 回答"抖店自动化怎么跑的 / 弱点在哪"

## 前置条件

1. Chrome 以 `--remote-debugging-port=9222 --user-data-dir=<目录>` 启动，且已登录抖店卖家后台（登录态随调试资料目录持久化）。
   - 新版 Chrome **禁止在默认资料目录开远程调试**，必须用非默认 `--user-data-dir`。
   - 频繁登录可能触发 geetest 滑块，需人工一次性拖拽；之后会话长期有效。
2. **Node ≥ 22**（内置 WebSocket，CDP 连接用 EventTarget API）。旧版 Node 需自装 `ws` 并经 `DD_WS_PATH` 指定。
3. step5 / step9 需要 Python 环境，含 `pandas` + `openpyxl`。
4. 登录凭据通过环境变量运行时注入，**绝不落盘**（见下）。

## 环境与路径配置（新机器必读）

所有脚本的机器相关常量均支持环境变量覆盖，公开仓库不含任何本机绝对路径：

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `DD_SHOP_A` / `DD_SHOP_B` | 两个店铺名（**必填**；店铺名前 3 字符需能互相区分，用于顶栏品牌匹配） | `店铺A` / `店铺B` |
| `DD_NODE` | Node 可执行文件 | `node` |
| `DD_PYTHON` | Python 可执行文件（step5/step9 用） | `python` |
| `DD_PYTHONPATH` | pandas/openpyxl 所在路径（隔离环境时用） | 空（用系统环境） |
| `DD_CHROME` | Chrome 可执行文件 | `C:/Program Files/Google/Chrome/Application/chrome.exe` |
| `DD_CHROME_USER_DATA` | Chrome 调试用户数据目录（登录态在此） | `C:/tmp/chrome-debug` |
| `DD_TMP_DIR` / `DD_DL_DIR` | 临时目录 / 下载暂存目录 | `C:/tmp` / `C:/tmp/doudian-dl` |
| `DD_WS_PATH` | 旧版 Node 的 `ws` 模块路径（Node ≥ 22 无需设置） | 无 |
| `DOUDIAN_EMAIL` / `DOUDIAN_PASSWORD` | 登录凭据（运行时注入，写入 `.env` 且 `.env` 不入版本库） | 无 |
| `DOUDIAN_BRAND` | 单步运行时指定当前店铺（run-all 自动按店铺设置） | `DD_SHOP_A` |

Windows 定时入口 `daily-run.bat` 会读取同目录 `.env` 注入上述变量；Linux/macOS 可用 `export` 或 `.env` + dotenv 等价方式。

## 流水线（11 步，`scripts/run-all.cjs` 编排）

```
1.  open-chrome-doudian.*      启动/复用 Chrome + 进入后台，清理非 fxg 标签
2+3. doudian-login-and-enter   登录 + 选店状态机（backend/shopselect/login/unknown）
4.  step4-export.cjs   [店铺A] 商品管理导出
5.  step5-yujing.cjs   [店铺A] 精选联盟佣金：canvas 扫蓝线 + hover tooltip → 7 天佣金
6.  step6-compass.cjs  [店铺A] 电商罗盘：商品/达人/交易三明细导出
7.  step7-switch-shop.cjs      切换店铺（hover 品牌 → 切换组织/店铺 → 选目标 → reload）
8.  step4-export.cjs   [店铺B] 商品管理导出
9.  step5-yujing.cjs   [店铺B] 精选联盟佣金
10. step6-compass.cjs  [店铺B] 电商罗盘导出
11. step9-build-report.cjs     合并双店铺 5-sheet 日报
```

- 步骤 4–6 / 8–10 是同一组脚本以不同 `DOUDIAN_BRAND` 调用。
- **step7 是 `critical:true`**：切换失败即硬停，防止店铺间数据污染（P0 风控，见 references/known-pitfalls.md）。
- 断点续跑：`state/YYYY-MM-DD.json` 记录当天已完成步骤，崩溃/重跑自动跳过；同日二次触发幂等（缺项但产物已存在则补记检查点，再跑全跳过、零采集）。

## 运行方式

全流程（凭据从环境变量来；会话有效可跳过登录）：
```bash
DOUDIAN_EMAIL=xxx DOUDIAN_PASSWORD=xxx DD_SHOP_A='店铺A名' DD_SHOP_B='店铺B名' node scripts/run-all.cjs
node scripts/run-all.cjs --skip=login        # 会话已有效
node scripts/run-all.cjs --skip=second       # 只跑店铺A
node scripts/run-all.cjs --skip=step5        # 跳过单步
node scripts/run-all.cjs --fresh             # 清空当天检查点强制重采（慎用，可能触发滑块）
```

**重要：必须前台执行，超时给足（600s）**；后台模式可能被环境强杀。

### 补跑单店（重要！）

**补跑单店不要走 run-all**（登录步会把店铺切回店铺A → 店铺B 的 ensureBrand 必败）。正确姿势：
1. `node scripts/step7-switch-shop.cjs`（切到目标店铺）
2. `DOUDIAN_BRAND=<目标店> node scripts/step5-yujing.cjs`（或 step6）
3. `node scripts/step9-build-report.cjs`

例外：`.env` 未设 `DOUDIAN_BRAND` 时默认店铺A且会自动切回，可直接跑。

### 产物

按数据日期建目录 `YYYY-MM-DD/`，每店铺 5 个文件：
`{date}_{brand}_商品管理导出.xlsx` / `_日常报表.xlsx`（佣金）/ `_商品列表.xlsx` / `_达人列表.xlsx` / `_交易明细.xlsx`。
step9 把每家 `日常报表.xlsx` 重写为 5-sheet 合并格式：
Sheet1 佣金 / Sheet2 成交概览 / Sheet3 自营成交 / Sheet4 商品列表 / Sheet5 达人列表（丢成交商品=0）。

## 各步骤内部要点（快速参考）

- **step4-export**：真实点击侧边栏「商品管理」→「导出查询商品」→「导出」→ 关新标签 →「查看导出记录」→ 匹配最近记录（严格 `> exportStartTime-90s`）→ `Network.responseReceived` 拦截 `downloadTaskResult` + Node HTTP 带 Cookie 直下 → 归档（日期 = 记录完成时间 - 1 天）。重复点击防护：最多 2 次点击。
- **step5-yujing**：精选联盟 → buyin 新标签 → 看数据 → 只勾「预估佣金支出」（刷新后 checkbox 重置，需三级点击重勾）→ **自适应 canvas x 范围扫描蓝线 (25,102,255)** → CDP hover 7 采样点 → before/after DOM 对比捕获 tooltip → 正则解析 → Excel。**退出码 0 不代表数据齐，必须核对 7 天窗口含 T-1**。
- **step6-compass**：电商罗盘 → compass 新标签；商品/交易 hover「下载明细」→「下载当前明细」，达人**直接点**「下载明细」（下拉被引导提示拦截）。数据日期 = 运行时前一天。`waitForDownload` 双重归属校验防串档。**B1 防污染**：开 compass 后校验顶栏店铺名 == BRAND，不符即退出；最多 3 次"关 compass→回 fxg 暖机→重开再校验"。
- **step7-switch-shop**：读当前品牌 → hover 品牌名 → 点「切换组织/店铺」→ 弹窗选目标店（带图标子元素，勿限 children）→ `Page.reload()` + 侧边栏就绪轮询 → 切完把鼠标移开顶栏防浮层残留。
- **step9-build-report**：Python/pandas；长数字列（≥12 位纯数字 + 关键词列）强制文本 `@` 防 19 位商品编码精度丢失；源文件缺失填空 DataFrame；日期 fallback 昨天→前天；`open(...,'rb')` 显式关句柄 + `gc.collect()` 防 WinError 5 文件占用。

## 硬规则（实战铁律）

1. **店铺名匹配用前 3 字符**（顶栏品牌 + 店铺列表），两个店铺名前 3 字符必须不同。
2. **step7 是硬阻断点**，绝不允许静默失败继续采集（否则数据归档错店）。
3. **compass 防污染（B1）**：开 compass 必校验店铺名；「切换数据视角」仅 B1 失败兜底，绝不跨店乱切。
4. React 受控组件（登录表单/checkbox/顶栏 tab）一律 **CDP 真实鼠标点击或原生 value setter**，`el.click()` 无效。
5. 点顶部导航前先解除搜索框焦点（点空白区），否则顶栏标签被浮层遮挡。
6. 凭据只走环境变量；`.env` 只存键名与占位，**不提交版本库**。
7. step5 完成后必须核对数据窗口含 T-1，别信退出码。
8. 迁移新机器：先按「环境与路径配置」表核对全部变量，再跑单步冒烟（step4 最安全），最后全流程。

## 资源

### scripts/（生产脚本，run-all 编排；单步可独立调用）
`run-all.cjs`（11 步主控 + 断点续跑 + 容错）、`open-chrome-doudian.sh/.mjs`、`doudian-login-and-enter.mjs`（登录状态机）、`step4/5/6/7/9-*.cjs`、`brand-helper.cjs`（品牌校验/切换，被 step4~7 复用）、`fail-capture.cjs`（fatal 截图 + diag）、`daily-run.bat`（Windows 定时入口）。

### lib/（内置依赖，随技能分发）
`xlsx_pack.py` + `minimal_xlsx/` 模板（MIT）——step5 用最小 OOXML 模板 + zip 打包生成 xlsx，不依赖外部私有技能。

### references/（按需阅读）
- `cdp-patterns.md` — CDP 连接拓扑、稳健封装、React 输入填充、死锁规避、Node 约束
- `topnav-dom.md` — 顶栏精确 DOM；**搜索框焦点会偷走顶栏标签**（先解除焦点再点导航）
- `known-pitfalls.md` — 完整踩坑 + 修复记录（含 8 月新坑：compass B1 防污染、长数字精度、WinError 5、step4 防重复点击）

## 已知限制

- 依赖抖店前端 DOM（class hash 后缀、坐标），前端改版需回归调试；运行时内置重试/兜底，无结构性根治。
- 依赖屏幕分辨率稳定（坐标点击基于视口）。
- 无自动验证码通过能力：geetest 滑块需人工一次性拖拽。
