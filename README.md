# douyin-shop-data.skill — 抖店自动化 Skill 仓库

托管抖店（抖音电商）卖家后台自动化相关的可复用 Skill（**脱敏公开版**，不含任何真实账号/店铺名/机器路径）。

## 主 Skill：douyin-daily-report（抖店双店铺日报流水线）

端到端浏览器自动化流水线：通过 Chrome CDP 驱动抖店卖家后台，对**两个店铺**依次导出商品 / 佣金 / 电商罗盘数据，切店后重复，最后合并为 5-sheet Excel 日报。

| 资源 | 说明 |
|---|---|
| `SKILL.md` | Skill 主文档（概览 / 配置 / 11 步流水线 / 运行方式 / 硬规则） |
| `scripts/` | 生产脚本：`run-all.cjs`（11 步主控 + 断点续跑）+ `step4~9` + `brand-helper` + 登录/启动 |
| `references/` | CDP 稳健模式 / 顶栏 DOM 结构 / 完整踩坑记录 |
| `lib/` | 内置 xlsx 打包器（MIT），无外部私有依赖 |
| `.env.example` | 配置模板（店铺名 / 路径 / 凭据全部环境变量化） |

### 快速开始

```bash
# 1. 配置（复制 .env.example 为 .env，填写两个店铺名与登录凭据）
cp .env.example .env

# 2. 依赖：Node >= 22（内置 WebSocket）+ Python（pandas / openpyxl）

# 3. 运行完整流水线
DOUDIAN_EMAIL=... DOUDIAN_PASSWORD=... node scripts/run-all.cjs
```

详细说明见 [`SKILL.md`](./SKILL.md)。

## legacy：compass-skill（电商罗盘数据下载，已归档）

旧版「抖店电商罗盘数据自动下载」Skill（商品 / 达人 / 交易三表下载 + 日报聚合），能力已被主 Skill 的 step6 覆盖，保留在 [`legacy/compass-skill/`](./legacy/compass-skill/) 供参考。

## 安全说明

- 仓库不含任何真实账号 / 店铺名 / 机器绝对路径，全部经环境变量注入
- `.env`、`scripts/config.local.js` 已被 `.gitignore` 忽略，**切勿提交**
- 凭据仅运行时使用，绝不落盘到版本库
