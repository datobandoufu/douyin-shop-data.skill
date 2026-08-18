# 抖店数据下载 — 完整工作流

## 前置条件

- 项目目录：`<你的项目目录>`（可用环境变量 `PROJECT_DIR` 覆盖；脚本默认当前工作目录）

## 品牌信息

> 下面为示例占位，请改成你自己的店铺。真实配置写在 `scripts/config.js` 的 `BRAND_CONFIG` 中。

| 品牌简称 | 店铺名 |
|---------|--------|
| 品牌A | 品牌A官方旗舰店 |
| 品牌B | 品牌B官方旗舰店 |

账号：`<你的抖店登录邮箱>`（同一账号管理多店铺；建议用环境变量 `DOUYIN_EMAIL` / `DOUYIN_PASSWORD` 传入）

## 步骤 0：启动浏览器（如未运行）

**在执行任何操作前，必须先确保 Chrome 可用。**

1. 检查端口 9222 是否响应：`curl -s http://localhost:9222/json/version`
2. 若未响应，执行脚本：`PowerShell scripts/start-chrome.ps1`
   - 脚本会杀旧进程、启动 Chrome、等待最多 30 秒
3. 从 `http://localhost:9222/json/version` 获取 browser WebSocket URL

## CDP 实现方式

> **必须使用 async/await CDPClient 封装类，禁止回调式事件监听状态机。**
>
> 详见 `references/cdp-patterns.md`。

**优先使用稳定脚本，避免每次重新生成：**
```bash
# 商品列表
node scripts/product-download.mjs <browserWsUrl> [--date YYYYMMDD]
# 达人列表
node scripts/influencer-download.mjs <browserWsUrl> [--date YYYYMMDD]
```

脚本自动检测参数：不传 WS URL 时通过 `curl localhost:9222/json/version` 获取；不传 `--date` 时默认为昨天。全流程不产生多余中间文件。

**备选（手写脚本）**：每次执行写在独立的 `.mjs` 脚本中，脚本顶部粘贴 CDPClient 类（从 `cdp-patterns.md`），用 `main()` 入口串联所有步骤。

### 多品牌执行

一个账号管理多店铺时，使用 `download-all.mjs` 一次登录后自动切换：

```bash
node scripts/download-all.mjs [--date YYYYMMDD] [--brands 品牌A,品牌B,...]
```

**首次执行前需要手动完成滑块验证**。登录一次后 cookies 保持，后续无需重复登录。

## 多品牌切换（仅手写脚本时需要）

同一账号下载多个店铺数据时，品牌之间需插入切换步骤。详细 DOM 选择器见 `react-fiber-patterns.md` 模式 5：

1. 在 compass 页面 hover `.userDropDown-k9_W5P`（CDP `mouseMoved`）
2. Fiber D0 点击 `.switchAccount-jAhEuJ` → 弹窗出现
3. Fiber D0 点击目标品牌的 `index_roleItem__3R8yT`
4. 页面跳转 compass 首页，然后导航到商品列表/达人列表继续下载

## 步骤 1：登录态检测与登录

**先尝试直接进入后台，确认是否需要登录。**

1. 导航到抖店首页：`https://fxg.jinritemai.com/ffa/mshop/homepage/index`
2. 检查页面标题：
   - 若标题为"首页" → **已登录**，跳过步骤 1，直接进入步骤 2
   - 若标题包含"登录" → **需要登录**，继续下方步骤

3. 登录流程（仅当未登录时）：
   - 导航到登录页：`https://fxg.jinritemai.com/login/common`
   - 切换到邮箱登录：点击 `account-center-switch-button` 中内容为"邮箱登录"的按钮
   - 填入账号（见 `scripts/config.js` 的 `ACCOUNTS`）、密码（见 `config.js` 的 `PASSWORD` 或环境变量 `DOUYIN_PASSWORD`）（`nativeInputValueSetter` + `dispatchEvent(input)`）
   - 勾选协议 checkbox（`input[type=checkbox]`）
   - 点击登录按钮
   - **若出现滑块验证码，告知用户手动完成，等待用户确认后继续**

## 步骤 2：导航到商品列表

**直接 URL 导航（推荐）** — cookies 通过 `--user-data-dir` 共享，无需从首页点击：

```
浏览器 → Target.createTarget(url: https://compass.jinritemai.com/shop/commodity/product-list)
→ 等待 Page.loadEventFired → 验证 title === "商品列表-抖音电商罗盘"
```

备选方案（直接 URL 不行时使用）：
1. 在抖店首页点击 `[data-guide="tabBar-电商罗盘"]` → 打开 compass 新标签页
2. 在 compass 顶部导航中点击 `aurora-dropdown-trigger` 文本为"商品"（非"商品卡"）

## 步骤 3：设置时间为昨天

1. 确认页面标题为"商品列表-抖音电商罗盘"
2. 用 dispatchEvent + MouseEvent 链（参考 react-fiber-patterns.md 模式 1）选中 `value=one` 的 radio
3. 验证日期范围变为 `YYYY/MM/DD-YYYY/MM/DD`（昨天）

## 步骤 4：下载商品明细

1. 从按钮 `.downloadDrop-kGtGGo` 的 fiber 向上遍历 5 层找到 `onPopupVisibleChange` handler，调用 `true` 打开下拉菜单
   - Fallback：D4 → D6（已在 `product-download.mjs` 内置）
   - **不要查找 `.ecom-dropdown` 父容器**（当前 DOM 中不存在）
2. 用 fiber onClick 逐层查找 handler，点击下拉项"下载当前明细"
3. 等待 2 秒后检查 `$HOME/Downloads/` 目录，确认文件已出现
4. 文件名模式：`经营版_商品_商品列表__YYYYMMDD-YYYYMMDD_数据更新时间YYYYMMDD.xlsx`

## 步骤 5：整理商品列表文件

使用归档脚本：
```bash
bash scripts/archive.sh 商品列表 YYYYMMDD
```

脚本自动查找最新文件 → 创建日期文件夹 → 移动并重命名为 `YYYYMMDD_品牌名_商品列表.xlsx`。

---

## 步骤 6：切换到合作达人列表

**直接 URL 导航（推荐）**：

```
浏览器 → Target.createTarget(url: https://compass.jinritemai.com/shop/talent-core-analysis)
→ 等待 Page.loadEventFired → 点击 [role=tab] 文本为 "合作达人" → 验证 title === "合作达人列表-抖音电商罗盘"
```

备选方案：
1. 在商品列表页面，点击顶部导航的 `aurora-dropdown-trigger`，文本为"达人"
2. 进入达人概览后，点击子 tab 中的"合作达人"标签

## 步骤 7：设置时间为昨天（达人列表）

1. 使用与步骤 3 相同的方式（dispatchEvent + MouseEvent 链）选中 `value=one` 的 radio
2. 验证日期范围变为昨天

## 步骤 8：下载达人明细

**注意：达人页面的下载按钮与商品列表页不同。** class 是 `ecom-btn ecom-btn-default withTooltip-lLfGho`（无 `ecom-dropdown-trigger`），是一个直接下载按钮，没有下拉菜单。

1. 通过 React fiber（深度 8，fallback D6/D7/D9）调用 `onDownload` 触发 API 请求
2. 同时启用 CDP `Network.enable` 监控网络请求
3. 拦截 URL 中包含 `cooperate/list/download` 的请求
4. 等待 `Network.loadingFinished` 后调用 `Network.getResponseBody` 获取响应体（base64 编码）
5. 将响应体解码并直接写入项目目录

## 步骤 9：整理达人列表文件

达人列表通过 CDP Network 拦截直接写入，无需额外移动：
- 路径：`$PROJECT_DIR/YYYYMMDD/YYYYMMDD_品牌名_达人列表.xlsx`
- 已在步骤 8 中完成写入

---

## 步骤 10：导航到交易（成交分析）

**直接 URL 导航（推荐）**：

```
浏览器 → Target.createTarget(url: https://compass.jinritemai.com/shop/business-part)
→ 等待 Page.loadEventFired → 验证 title 含 "全店成交分析" 或 "成交"
```

备选方案：
1. 在电商罗盘顶部导航点击 `aurora-dropdown-trigger`（`menuName-iiOPo5`），文本为"交易"
2. 进入默认子页「全店成交分析」

> ⚠️ **交易明细文件名不含品牌**：导出文件名是 `抖音电商罗盘-成交分析-YYYYMMDD-YYYYMMDD.xlsx`，不含店铺名。下载前必须先切对数据视角，否则会下到 A 店数据却错标成 B 店。`transaction-download.mjs` 已内置 `switchStore` 自动切视角。

## 步骤 11：设置时间为昨天（交易明细）

1. 选中 `value=one` 的 radio（"近1天"，在交易页等同昨天）
2. 验证日期范围变为昨天

## 步骤 12：下载成交分析明细

1. 点击「下载明细」按钮（class 含 `ecom-dropdown-trigger`，文字含"下载明细"）→ 打开下拉
2. fiber onClick 逐层查找 handler，点击下拉项"下载当前明细"
3. 触发接口 `compass_api/download_center/shop/download_file_sync`（scene=`compass_shop_transaction_analysis_download`）
4. 文件落盘 `$HOME/Downloads/抖音电商罗盘-成交分析-YYYYMMDD-YYYYMMDD.xlsx`

## 步骤 13：品牌校验 + 归档（交易明细）

**推荐直接调用 `transaction-download.mjs`**（已内置切店铺 + 快照归档 + 品牌校验，无需手写）：

```bash
node scripts/transaction-download.mjs <browserWsUrl> --date YYYYMMDD --brand <品牌简称>
```

脚本内置流程：
1. 连接浏览器 → 若当前店铺视角 ≠ 目标品牌，先 `switchStore` 切换（Hover `.userDropDown-k9_W5P` → fiber D0 点 `.switchAccount-jAhEuJ` → fiber D0 选 `index_roleItem__3R8yT`）
2. 导航交易页 → 选近1天 → 点击「下载当前明细」
3. **快照法**：点击下载前记录 `Downloads` 已有文件，**只认点击后新出现的文件**（避免 `ls -t` 误匹配旧文件错标）
4. **品牌内容校验**：调用 `extract-products.py` 提取「商品构成」sheet 商品名 → 品牌排斥匹配；出现非目标品牌特征词即拒绝归档（`process.exit(1)`，保留原文件待人工核查）
5. **safeArchive**：先复制为 `.part` 再 `rename`，源/目标任一被 Excel 锁（项目目录 `~$` 锁文件）都自动重试（≤60 次），等 Excel 关闭后自动完成
6. 归档为 `YYYYMMDD/YYYYMMDD_品牌名_交易明细.xlsx`

---

## 步骤 14：生成日报（三表聚合）

某品牌 商品列表 + 达人列表 + 交易明细 三表均下载完成后，自动聚合生成 **`YYYYMMDD_品牌名_日报.xlsx`**（4 个 sheet）。

**推荐直接调用 `generate-daily-report.py`**（也可由 `download-all.mjs` 在每品牌三表下载后自动触发）：

```bash
python scripts/generate-daily-report.py --date YYYYMMDD --brand <品牌简称>
# 依赖 venv openpyxl（解释器路径见 scripts/config.js 的 PYTHON）
```

**4 个 sheet 的数据源与过滤规则：**

| Sheet 名 | 数据源 | 过滤规则 |
|----------|--------|----------|
| `交易明细-成交概览` | 交易明细「成交概览」sheet | 载体类型 = **全部** 且 投放时段 = **不限** |
| `交易明细-自营成交` | 交易明细「自营成交」sheet | 仅 投放时段 = **不限**（不限载体类型，保留全部/直播/短视频/商品卡/图文/其他各行） |
| `商品列表` | 商品列表（全部 sheet） | 全量数据（不过滤） |
| `达人列表` | 达人列表（抖音直播 sheet） | 成交商品 **≠ 0**（剔除非成交达人） |

- 过滤按表头名精确匹配列（`载体类型` / `投放时段` / `成交商品`），不依赖列顺序
- 仅保留表头 + 命中行，保留源表全部列
- 三表任一缺失则跳过该品牌日报

---

## 验证清单

- [ ] Chrome 已通过 `start-chrome.ps1` 启动且端口 9222 响应
- [ ] CDP 脚本使用 async/await CDPClient 封装（非回调状态机）
- [ ] 多品牌：使用 `download-all.mjs` 一键执行（含自动切换数据视角）
- [ ] 单品牌：使用 `product-download.mjs` + `influencer-download.mjs`（无需每次重新生成）
- [ ] 登录态已确认（首页标题"首页"）
- [ ] 商品列表页面标题是"商品列表-抖音电商罗盘"
- [ ] 达人列表页面标题是"合作达人列表-抖音电商罗盘"
- [ ] 两个页面的时间筛选均显示"近1天"为 active
- [ ] 日期范围为昨天
- [ ] 商品下拉支持 D5/D4/D6 fallback
- [ ] 达人下载支持 D8/D6/D7/D9 fallback
- [ ] 品牌切换：hover `.userDropDown-k9_W5P` + fiber D0 点击 `.switchAccount-jAhEuJ` + fiber D0 点击 `index_roleItem__3R8yT`
- [ ] `$PROJECT_DIR/YYYYMMDD/` 下有所有品牌的商品列表、达人列表、交易明细 Excel 文件
- [ ] 交易明细：使用 `transaction-download.mjs` 一键流程（内置切店铺 + 快照归档 + 品牌校验）
- [ ] 交易明细已通过品牌校验（verdict ok / hitTarget，未出现串味拒绝）
- [ ] 交易明细归档文件名：`YYYYMMDD_品牌名_交易明细.xlsx`
- [ ] 三表齐全后已生成 `YYYYMMDD_品牌名_日报.xlsx`
- [ ] 日报含 4 个 sheet：交易明细-成交概览 / 交易明细-自营成交 / 商品列表 / 达人列表
- [ ] 日报「成交概览」只含「全部/不限」一行（载体类型=全部 且 投放时段=不限）
- [ ] 日报「自营成交」含 投放时段=不限 的所有载体类型行（全部/直播/短视频/商品卡/图文/其他，不限载体）
- [ ] 日报「达人列表」已剔除「成交商品=0」的行
- [ ] 每次页面加载后等待至少 3 秒再操作（SPA hydration）
- [ ] 每次运行前先检查是否已有当天文件，避免重复下载
