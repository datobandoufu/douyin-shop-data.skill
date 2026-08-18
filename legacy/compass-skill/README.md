# douyin-shop-data

抖店（抖音电商）商家后台 + 电商罗盘数据自动下载 Skill。

自动化从 **抖店后台 → 电商罗盘** 拉取三类数据，并聚合生成每日 **`日期_品牌_日报.xlsx`**：

- **商品列表**（compass 商品列表页）
- **达人列表**（compass 合作达人页，CDP 网络拦截写入）
- **交易明细 / 成交分析**（compass「交易」→「全店成交分析」，快照法 + 品牌内容校验归档）
- **日报聚合**：三表下载完成后自动生成 4 个 sheet（成交概览 / 自营成交 / 商品列表 / 达人列表）

## 核心特性

- 🤖 多店铺支持：一个账号管理多店，自动切换「数据视角」下载各店数据
- 🛡️ 品牌内容校验：交易明细文件名不含品牌，靠「商品构成」sheet 的商品名做排斥匹配，防止多店铺数据串味错标
- 📸 快照法归档：只认点击下载后新出现的文件，规避旧文件误匹配
- 🔒 隐私安全：本仓库**不含任何账号密码 / 真实店铺名**，全部配置集中在 `scripts/config.js`（占位符 + 环境变量注入）

## 目录结构

```
douyin-shop-data/
├── SKILL.md                      # 总说明（能力 / 流程 / 坑点 / 配置）
├── README.md                     # 本文件
├── references/
│   ├── cdp-patterns.md          # async/await CDPClient 封装 + 网络拦截
│   ├── cdp-helpers.js           # Runtime.evaluate 可复用注入函数
│   ├── react-fiber-patterns.md  # React 受控组件操作模式
│   └── workflow.md               # 完整工作流
└── scripts/
    ├── start-chrome.ps1         # 重启 Chrome（9222 调试端口）
    ├── config.js                # ★ 你的店铺/账号配置（占位符，请修改）
    ├── download-all.mjs         # ★ 多品牌一键编排（核心入口）
    ├── product-download.mjs     # 商品列表下载 + 归档
    ├── influencer-download.mjs  # 达人列表下载（CDP 拦截写入）
    ├── transaction-download.mjs # 交易明细下载（切店+快照+校验）
    ├── generate-daily-report.py # ★ 日报聚合（4 sheet）
    ├── extract-products.py      # 提取商品名做品牌校验
    ├── archive.sh               # 商品/达人列表归档重命名
    ├── navigate-shop.mjs        # 辅助：打开抖店后台
    └── navigate-compass.mjs     # 辅助：打开电商罗盘
```

## 快速开始

### 1. 准备配置

编辑 `scripts/config.js`，把你自己的店铺与账号填进去（**推荐用环境变量传入密码，不要硬编码明文**）：

```bash
export DOUYIN_EMAIL="你的抖店登录邮箱"
export DOUYIN_PASSWORD="你的抖店登录密码"
```

`config.js` 中需要改的字段：

| 字段 | 说明 |
|------|------|
| `BRAND_CONFIG` | 各品牌的 `fullName`（切换数据视角弹窗中的店铺全名）与 `keywords`（商品名特征词，用于校验） |
| `DEFAULT_BRANDS` | 默认下载的品牌顺序 |
| `ACCOUNT.email` / `ACCOUNT.password` | 登录账号（建议用环境变量覆盖） |

### 2. 启动浏览器（调试模式）

```bash
PowerShell scripts/start-chrome.ps1
```

需要 Chrome 以 `--remote-debugging-port=9222` 启动，并复用你的用户数据目录（已登录态）。

### 3. 一键下载 + 日报

```bash
# 默认下载 config.js 中的 DEFAULT_BRANDS
node scripts/download-all.mjs --date 20260707

# 指定品牌
node scripts/download-all.mjs --brands 品牌A,品牌B --date 20260707
```

产出在 `$PROJECT_DIR/YYYYMMDD/`（默认当前工作目录，可用环境变量 `PROJECT_DIR` 覆盖）：

```
20260707/
├── 20260707_品牌A_商品列表.xlsx
├── 20260707_品牌A_达人列表.xlsx
├── 20260707_品牌A_交易明细.xlsx
├── 20260707_品牌A_日报.xlsx
└── ...（每个品牌一套）
```

## 环境依赖

- **Node.js**（运行 `.mjs` 脚本，依赖 `ws` 包）
- **Python 3** + `openpyxl`（`generate-daily-report.py` / `extract-products.py`）
  - 通过环境变量 `PYTHON_VENV` 指定你的 venv 解释器路径；不指定则用 `PATH` 中的 `python`
- **Google Chrome**（调试端口 9222）

## 重要说明

- 交易明细文件名不含品牌，且首次登录常需**手动滑块验证**——脚本会等待你完成验证后继续。
- 多店铺切换依赖后台「切换数据视角」弹窗，品牌 `fullName` 必须与弹窗中显示的一致。
- 品牌 `keywords` 请用真实商品名校准，保证各品牌互不交叉，才能使内容校验准确。

## 隐私声明

本仓库**刻意不含任何真实账号、密码、店铺名或本机绝对路径**。所有敏感信息由使用者通过
`scripts/config.js` 或环境变量本地提供，请勿将含真实凭据的文件提交进版本库。
