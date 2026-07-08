---
name: douyin-shop-data
description: >-
  抖店电商罗盘自动化数据下载。支持自动登录抖店、导航至电商罗盘商品列表 / 达人列表 / 交易明细（成交分析）、
  设置日期筛选（近1天/近7天/近30天等）、下载各类明细 Excel、
  并通过「商品构成」sheet 的商品名称做品牌内容校验（防止多店铺数据串味错标）、将文件整理到项目目录中。
  下载完成后自动聚合生成「日期_品牌_日报.xlsx」（4 个 sheet：成交概览/自营成交/商品列表/达人列表）。
  适用于每日定时拉取抖店商品经营数据并产出日报。
  触发词：抖店、电商罗盘、商品列表、达人列表、交易明细、成交分析、下载明细、抖店数据、日报、进入抖店、进入电商罗盘、打开抖店、打开电商罗盘。
agent_created: true
---

# 抖店电商罗盘数据下载

本 skill 自动化从抖店后台 → 电商罗盘 → 商品列表 + 达人列表 + 交易明细（成交分析）的数据拉取流程。

## 何时使用

- 用户要求从抖店下载商品数据和达人数据
- 用户要求从电商罗盘「交易」标签下载交易明细（成交分析）
- 用户需要获取抖店商品经营数据、合作达人数据、店铺成交分析数据并产出日报
- 指定日期范围的商品明细 + 达人明细 + 交易明细下载
- 需要防止多店铺数据串味（交易明细文件名不含品牌，需靠商品名做内容校验归属）

## 核心能力

1. **浏览器连接** — 通过脚本启动/检测 Chrome + CDP WebSocket 直连
2. **登录抖店** — 自动填充邮箱登录表单（需手动滑块验证）
3. **导航与筛选** — 直接 URL 导航至商品列表、达人列表、交易（成交分析）页面，设置时间范围
4. **下载与整理** — 触发下载明细，交易明细采用快照法 + 品牌内容校验归档到项目日期文件夹
5. **日报聚合** — 三表下载完成后调用 `generate-daily-report.py` 生成「日期_品牌_日报.xlsx」（4 个 sheet）

## CDP 实现规则（关键）

> **所有 CDP 多步骤流程必须使用 async/await CDPClient 封装（见 `references/cdp-patterns.md`），
> 禁止使用 `ws.on('message')` 回调式事件监听状态机。**
>
> 原因：回调模式在多层 WebSocket + 多步骤场景下极容易漏事件、状态混乱、难以调试。
> CDPClient 将 `send()` 转为 Promise、`waitFor()` 阻塞等待事件、`eval()` 直接返回 JS 执行结果，
> 使脚本顺序执行，逻辑清晰。

### 每次执行的脚本结构

```js
import WebSocket from 'ws';

// 1. 粘贴 CDPClient 类（从 cdp-patterns.md）
class CDPClient { /* ... */ }

// 2. main() 串联所有步骤
async function main() {
  const browser = new CDPClient(BROWSER_WS); await browser.connect();
  // ... 创建 page target → 等待加载 → 操作 → 下载 ...
}
main().catch(e => { console.error(e); process.exit(1); });
```

### 导航策略

- **优先直接 URL 导航**（`Target.createTarget` + 完整 URL），cookies 通过 `--user-data-dir` 共享
- 备选：从首页点击导航按钮（多一步 tab 切换，更易出错）
- 页面加载后至少等待 3 秒（SPA hydration 需时间）
- **仅打开页面（不下载）**：若用户只要求「打开/进入抖店」或「打开/进入电商罗盘」，直接跑 `scripts/navigate-shop.mjs` / `scripts/navigate-compass.mjs`（经 CDP 新建标签页并读取 URL/title 确认进入，不触发任何下载）

## 可复用资源

| 文件 | 类型 | 用途 |
|------|------|------|
| `scripts/start-chrome.ps1` | PowerShell | 杀旧 Chrome 进程，以调试模式重启（max 30s 含重试） |
| `scripts/navigate-shop.mjs` | Node.js | 辅助：经 CDP 新建标签页打开抖店后台（`https://fxg.jinritemai.com/`），读取 URL/title 确认已进入（用于「打开/进入抖店」类需求） |
| `scripts/navigate-compass.mjs` | Node.js | 辅助：经 CDP 新建标签页打开电商罗盘（`https://compass.jinritemai.com/shop`），读取 URL/title 确认登录态有效（用于「打开/进入电商罗盘」类需求） |
| `scripts/download-all.mjs` | Node.js | **多品牌编排脚本**，登录一次 → 按序下载所有品牌数据（商品列表→达人列表→交易明细） |
| `scripts/product-download.mjs` | Node.js | 商品列表下载 → 归档（--brand / --date 参数化） |
| `scripts/influencer-download.mjs` | Node.js | 达人列表下载 + CDP Network 拦截写入（fiber 多深度 fallback） |
| `scripts/transaction-download.mjs` | Node.js | 交易明细（成交分析）下载：内置 switchStore 切店铺 → 快照法归档 → 品牌内容校验 |
| `scripts/generate-daily-report.py` | Python | **日报生成**：聚合三表 → 输出「日期_品牌_日报.xlsx」（4 sheet：成交概览/自营成交/商品列表/达人列表） |
| `scripts/extract-products.py` | Python | 从交易明细 xlsx 提取「商品构成」sheet 的商品名称（供品牌校验，依赖 venv openpyxl） |
| `scripts/archive.sh` | Bash | 将下载文件移入 `YYYYMMDD/` 并按规则重命名（商品列表/达人列表用；交易明细已改为内置快照归档，不再走此脚本） |
| `references/cdp-helpers.js` | JS 片段 | `Runtime.evaluate` 注入用的可复用函数 |
| `references/react-fiber-patterns.md` | 参考 | React 组件操作模式详解 |
| `references/cdp-patterns.md` | 参考 | async/await CDPClient 封装类 + 网络拦截示例 |
| `references/workflow.md` | 参考 | 完整 10 步工作流 |

## 执行流程

### 快速开始（一键脚本）

```bash
# 多账号一键下载（推荐，含交易明细）
node scripts/download-all.mjs [--date YYYYMMDD] [--brands 品牌1,品牌2]

# 单账号手动
PowerShell scripts/start-chrome.ps1
BROWSER_WS=$(curl -s http://localhost:9222/json/version | grep -o '"webSocketDebuggerUrl": "[^"]*"' | cut -d'"' -f4)
node scripts/product-download.mjs "$BROWSER_WS" --brand <品牌简称>
node scripts/influencer-download.mjs "$BROWSER_WS" --brand <品牌简称>
node scripts/transaction-download.mjs "$BROWSER_WS" --brand <品牌简称>
```

`download-all.mjs` 内部编排：
1. 启动 Chrome → 登录一次（填写账号邮箱，见 `scripts/config.js` 的 `ACCOUNTS`）
2. **探测当前店铺视角**（`.userName-zP35aZ`），与 `--brands` 第一个品牌对比
3. 按品牌列表顺序：先切换数据视角（如需）→ 下载商品 + 达人 + 交易明细 → **生成日报**（三表齐全才生成）→ 汇总报告（汇总含四类 OK/FAIL：商品/达人/交易明细/日报）

**品牌切换流程**（`download-all.mjs` 内置）：<br>
`getCurrentStore()` 探测当前店铺 → 若与目标不一致则执行切换：<br>
Hover `.userDropDown-k9_W5P` → fiber D0 点击 `.switchAccount-jAhEuJ` → 弹窗中选择 `index_roleItem__3R8yT`（fiber D0）→ 页面跳转 compass 首页 → `product-download.mjs` + `influencer-download.mjs`

| 品牌简称 | 弹窗中店铺全名 |
|---------|-------------|
| `<品牌A简称>` | `<品牌A店铺全名>` |
| `<品牌B简称>` | `<品牌B店铺全名>` |

> 品牌简称与店铺全名映射在 `scripts/config.js` 的 `BRAND_FULL_NAMES` 中配置。

脚本参数：
- `--date YYYYMMDD`：指定日期，默认昨天
- `--brands 品牌A,品牌B`：指定品牌列表，默认读取 `config.js` 的 `BRANDS`
- `--brand`（子脚本）：单品牌名，默认读取 `config.js` 的第一个品牌

### 连接浏览器

优先使用脚本：`PowerShell scripts/start-chrome.ps1`。脚本会杀旧进程、以 `--remote-debugging-port=9222 --no-sandbox` 重启 Chrome、等待端口就绪（最多 30 秒，含重试）。

获取 browser WebSocket URL：
```bash
curl -s http://localhost:9222/json/version | grep -o '"webSocketDebuggerUrl": "[^"]*"' | cut -d'"' -f4
```

所有 CDP 操作用 Node.js 原生 WebSocket + async/await CDPClient 封装（见 `references/cdp-patterns.md`）。每次执行写在独立 `.mjs` 脚本中，脚本顶部粘贴 CDPClient 类。

### 操作 React 受控组件

抖店后台是 React SPA（@ecomelement/ui），常规 DOM 操作对受控组件无效。不同组件需要不同策略，详见 `references/react-fiber-patterns.md`：

- **ecom-radio-group**（时间筛选）→ dispatchEvent + MouseEvent 链
- **商品列表下载按钮**（打开下拉）→ fiber onPopupVisibleChange（D5 主，D4/D6 fallback）
- **dropdown 菜单项**（点击下载当前明细）→ React fiber onClick（逐层遍历找 handler）
- **达人直接下载按钮**（`.withTooltip-lLfGGo`）→ fiber onDownload（D8 主，D6/D7/D9 fallback）+ CDP Network 拦截响应体

### 时间范围选择

日期基于代码运行当天的昨天。筛选组件 radio value 映射：

| value | 含义 |
|-------|------|
| `one` | 近1天（昨天） |
| `seven` | 近7天 |
| `thirty` | 近30天 |

### 下载与归档

**执行顺序：先商品列表，后达人列表，最后交易明细。优先使用稳定脚本：**
- `node scripts/product-download.mjs <WS_URL>` — 商品列表全流程（导航 → 筛选 → 下载 → 归档）
- `node scripts/influencer-download.mjs <WS_URL>` — 达人列表全流程（导航 → 合作达人 tab → 筛选 → CDP 拦截下载）
- `node scripts/transaction-download.mjs <WS_URL>` — 交易明细全流程（切店铺视角 → 选近1天 → 下载当前明细 → 快照法归档 → 品牌校验）

**商品列表下载**（备选手动流程）：
- `Target.createTarget(url: compass...product-list)` → 等待 load → 时间筛选 → fiber D5 下拉 + fiber onClick
- 文件命名模式：`经营版_商品_商品列表__YYYYMMDD-YYYYMMDD_数据更新时间YYYYMMDD.xlsx`
- 归档命令：`bash scripts/archive.sh 商品列表 [YYYYMMDD]`

**达人列表下载**（备选手动流程）：
- `Target.createTarget(url: compass...talent-core-analysis)` → 等待 load → 点击合作达人 tab
- `Network.enable` → fiber onDownload（D8 主，D6/D7/D9 fallback）→ `Network.loadingFinished` + `Network.getResponseBody` → base64 解码写入
- 达人下载按钮为直接按钮（无下拉菜单）
- 直接写入项目目录 `${PROJECT_DIR}/${DATE}/`，无需额外归档

**交易明细下载**（成交分析，备用手动流程也可由 transaction-download.mjs 一站式完成）：
- 顶部导航「交易」(`aurora-dropdown-trigger menuName-iiOPo5`) → 默认子页「全店成交分析」(`/shop/business-part`)
- 日期选「近1天」(`input[type=radio][value=one]`)，罗盘中等同"昨天"，与日报约定一致
- 导出入口：「下载明细」(`ecom-dropdown-trigger`，文字含"下载明细") → 菜单项「下载当前明细」(fiber onClick)
- 下载文件名：`抖音电商罗盘-成交分析-YYYYMMDD-YYYYMMDD.xlsx`（`文件名不含品牌`，按当前店铺视角导出）
- 接口：`compass_api/download_center/shop/download_file_sync`，scene=`compass_shop_transaction_analysis_download`
- 导出含 12 个 sheet：成交概览/自营成交/合作成交/收支概况/载体构成/账号构成/单载体构成/终端构成/品类构成/商品构成/价格带构成/人群构成

### ⚠️ 交易明细两大坑（已修复，transaction-download.mjs 已内置）
1. **文件名不含品牌** → 下载前必须切对店铺视角，否则下到 A 店数据却标成 B 店。`transaction-download.mjs` 已内置 `switchStore`（Hover 店铺名 → 切换数据视角 → 选品牌），独立运行也能切对。
2. **archive.sh 的 `ls -t | head -1` 会误匹配旧文件** → 同一天 Downloads 里若有别的品牌/上次运行的交易分析文件，会取到旧文件导致错标。`transaction-download.mjs` 已改为**快照法**（点击下载前记录 Downloads 已有文件，**只认点击后新出现的文件**）并自带 `fs.copyFileSync` 归档，**不再调用 archive.sh**。商品列表/达人列表文件名含品牌与时间戳，仍走 archive.sh 不受影响。

### 🛡️ 品牌内容校验（关键，用户提供的判定方法）
- 交易明细文件名不含品牌，仅靠"切对视角"不够稳。判定思路：交易明细的「商品构成」sheet 内含商品交易数据，可用商品名判断表格所属品牌。
- `transaction-download.mjs` 归档前调用 `extract-products.py`（openpyxl 读 xlsx，venv 路径由 `PYTHON` 环境变量指定，详见 `scripts/config.js`）提取商品名，再做**品牌排斥匹配**——出现非目标品牌特征词即判定串味、`process.exit(1)` 拒绝归档（保留 Downloads 原文件待人工核查）；命中目标品牌词则通过。
- `BRAND_KEYWORDS`（示例）：`品牌A→['品牌A特征词']`、`品牌B→['品牌B特征词1','品牌B特征词2']`。各品牌特征词在 `scripts/config.js` 的 `BRAND_KEYWORDS` 中配置，用真实商品名校准，保证互不交叉 → 双向排斥匹配成立。
- ⚠️ `extract-products.py` **绝不能用 `read_only=True`** —— 罗盘导出的 xlsx 在该模式下读不到任何数据，会误判成「空模板」。必须用普通 `load_workbook(fp, data_only=True)`。
- ⚠️ 归档 EBUSY（Excel 锁）：归档目标 xlsx 被 Excel 打开时（项目目录 `~$` 锁文件），`safeArchive` 先复制为 `.part` 再 `rename`，源/目标任一被锁都自动重试（≤60 次），等 Excel 关闭后自动完成。

### 📊 日报生成（三表下载后自动聚合）

下载完某品牌 商品列表 + 达人列表 + 交易明细 后，`download-all.mjs` 自动调用 `generate-daily-report.py` 生成 **`日期_品牌_日报.xlsx`**，含 4 个 sheet：

| Sheet 名 | 数据源 | 过滤规则 |
|----------|--------|----------|
| `交易明细-成交概览` | 交易明细「成交概览」sheet | 载体类型 = **全部** 且 投放时段 = **不限** |
| `交易明细-自营成交` | 交易明细「自营成交」sheet | 仅 投放时段 = **不限**（不限载体类型，保留全部/直播/短视频/商品卡/图文/其他各行） |
| `商品列表` | 商品列表（全部 sheet） | 全量数据 |
| `达人列表` | 达人列表（抖音直播 sheet） | 成交商品 **≠ 0**（剔除非成交达人） |

- 过滤按表头名精确匹配列：`载体类型` / `投放时段` / `成交商品`，稳健不依赖列顺序。
- 仅保留表头 + 命中行，保留源表全部列。
- 三表任一缺失则跳过该品牌日报（汇总标记 FAIL）。
- 独立运行：`python generate-daily-report.py --date YYYYMMDD --brand 品牌简称`（依赖 venv openpyxl）。

**下载确认**：
- 触发下载后等待 5-8 秒
- 商品列表：检查 `$HOME/Downloads/` 目录确认文件完成
- 达人列表：CDP 拦截写入，无需检查 Downloads
- **不要短时间内重复触发下载**，每次运行前先检查是否已有当天文件

## 配置（账号与品牌）

本 skill 不内置任何账号密码。所有隐私配置集中在 `scripts/config.js`，可通过环境变量覆盖：

- `ACCOUNTS`：账号邮箱列表（登录时逐个尝试）
- `PASSWORD` 或环境变量 `DOUYIN_PASSWORD`：登录密码
- `BRANDS`：本次要下载的品牌简称列表
- `BRAND_FULL_NAMES`：品牌简称 → 弹窗中店铺全名 映射
- `BRAND_KEYWORDS`：品牌简称 → 商品名特征词 映射（用于交易明细内容校验）
- `PROJECT_DIR`：产出文件根目录（默认当前工作目录）
- `PYTHON`：含 openpyxl 的 Python 解释器绝对路径（venv），用于 `generate-daily-report.py` / `extract-products.py`
- `DOWNLOADS_DIR`：浏览器下载目录（默认 `$HOME/Downloads`）

> ⚠️ 切勿将真实账号密码提交进版本库。`config.js` 中请只保留占位符或用环境变量注入。

### URL
- 抖店后台：https://fxg.jinritemai.com/
- 电商罗盘：https://compass.jinritemai.com/shop
- 商品列表：compass.jinritemai.com/shop/commodity/product-list
- 达人列表：compass.jinritemai.com/shop/talent-core-analysis（→ 合作达人 tab）
