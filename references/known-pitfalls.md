# 已知问题与修复记录（踩坑清单）

以下为 2026-07-15 ~ 08-17 实战中暴露并修复的问题。复用时优先对照本表，避免重复踩坑。

## 登录态 / 选店
- **登录态误判**：「请选择店铺」页含文字「抖店工作台」，被误判为 `backend`。→ `detectState` 中 `shopSelect` 检查须前置。
- **品牌归档错误**：登录后不校验当前品牌，导致数据写错品牌目录。→ 登录后校验品牌 + 必要自动切换（step7 / brand-helper `ensureBrand`）。
- **登录触发 geetest 滑块**：频繁登录可能要求人工一次性验证；登录态保存在调试资料目录（默认 `C:/tmp/chrome-debug`，可配置），重启 Chrome 后 session 仍在，回「请选择店铺」页无需重登。
- **切换邮箱登录 tab 必须 CDP 真实鼠标点击**：`el.click()` 对 React 受控组件无效；用 `Input.dispatchMouseEvent` 取元素中心点击（`div.account-center-switch-button` 文本=邮箱登录）。

## 导出 / 下载
- **旧导出记录被误下载**：时间戳过滤窗口过宽，抓到历史记录。→ 严格 `记录时间 > exportStartTime - 90000ms`（约 90s 容差）。
- **step4 SPA 路由未初始化**：首次登录后点击侧边栏「商品管理」URL 不跳转 `/g/list`。→ 4 级兜底重试 + `location.href='/ffa/g/list'` 直接导航兜底。
- **step4 下载方式**：用 `Network.responseReceived` 匹配 `downloadTaskResult` + Node HTTP 带 Cookie 直下，比轮询文件系统稳。
- **step4 重复点击**：坐标点击后未轻量验证就信任，导致重复触发导出。→ 坐标点击 → 轻量验证 → 未触发只补一次 DOM click 并信任，真实触发交由导出记录轮询把关，最多 2 次点击（08-16 修复）。
- **step5 Canvas 两端缺数据**：固定 x 范围扫描漏掉折线两端像素。→ 自适应 x 范围扫描（先密集找 `[xMin,xMax]`，再均匀 7 采样点）。
- **step5 折线动画未画完采样错位**：canvas 线宽 < 画布宽 75% 判 partial 重试；`Number.isFinite` 防 NaN 崩 CDP（失败抛 NO_CANVAS）。**退出码 0 不代表数据齐，必须核对 7 天窗口含 T-1**。
- **step5 佣金 0 元解析 bug**：`if(val)` 把 0 当 falsy 跳过。→ 改 `typeof val==='number'` 判断。
- **step6 日期**：数据日期统一用「运行时前一天」（不读页面显示日期）。

## 顶部导航 / 弹窗
- **搜索框焦点遮挡顶栏**：见 `topnav-dom.md` 关键坑。step5/step6 点击导航前先解除焦点。
- **首页弹窗拦截**：推广弹窗/浮层遮挡顶部标签，导致 `NO_BUYIN_TAB`。→ `closePopups` 温和版（2 轮 Escape + 轻量扫描）。
- **step6 达人下载**：「下载明细」带 ▼ 但 hover 不出下拉（被引导提示拦截），须**直接 click**；商品/交易则 hover 出下拉 → 点「下载当前明细」。
- **下载归属串档**：上一子任务迟到文件被误归档。→ `waitForDownload` 双重归属校验（dlStartTs + nameKeys 白名单）（07-30/31 串档 bug）。

## 店铺切换 / 双店铺流水线（P0 风控）
- **step7 失败必须硬阻断**：早期静默继续导致数据污染（店铺B 数据归档到店铺A）。→ `run-all.cjs` 中 step7 设 `critical:true`，失败即停后续。
- **切换后 SPA 未就绪**：切换后 React 未重初始化。→ step7 切换成功后 `Page.reload()` + 侧边栏就绪轮询。
- **step7 下拉菜单未出现**：hover 品牌名有时下拉不出。→ hover 失败则 `clickAt` 品牌名兜底，再找「切换组织/店铺」。
- **切换弹窗店铺项匹配**：店铺项带图标子元素（children>0），早期要求 `children.length===0` 永远匹配不到。→ `findBrandInDialog` 按文本匹配（允许带图标子元素）（07-28 修复）。
- **compass 串店静默污染（B1）**：切店后若立即开 compass 会读到"切前店"数据却归档成当前店文件名。→ 开 compass 后校验顶栏店铺名 == BRAND，不符即 `process.exit(1)`；并做"关 compass→回 fxg 暖机→重开再校验"最多 3 次（08-12 根因修复）。
- **compass 数据视角切换（08-13 兜底）**：B1 失败时 `trySwitchCompassViaView` 兜底切店，仅 B1 失败分支调用；失败则退化暖机重试（双保险）。注意：compass 无前端切店入口，店铺=服务端 session，「切换数据视角」是兜底而非常规路径，绝不跨店乱切。

## 合并报表
- **缺文件崩溃**：源文件缺失时 step9 原会 `FileNotFoundError`。→ Python 容错：`os.path.exists` 判断，缺失则填空 DataFrame；日期 fallback（昨天无日报则回落前天）。
- **长数字精度丢失**：19 位商品编码经 pandas→openpyxl 写成数值后 Excel 仅 15 位精度。→「关键词列 + ≥12 位纯数字列」强制文本 `@`（08-13 修复）。
- **WinError 5 文件占用自锁**：pandas/openpyxl 延迟 finalizer 占用源文件句柄，同进程内重复读写报权限错误。→ 源读取 `with open(...,'rb')` 显式关句柄 + `gc.collect()` + 兜底字节覆盖写 `open(target,'wb')`（08-13 修复）。
- **step5 命名窗口滚动**：日报命名从 `lastDate` 改为「实时前一天」，保证数据窗口随日期滚动。

## 稳定性结论
- 无已知必现崩溃（温和版 `closePopups` 已修）。
- 剩余脆弱点：前端改版（class hash 后缀、坐标硬编码）、分辨率变化、弹窗偶发遮挡——依赖运行时重试/兜底，无结构性根治。
