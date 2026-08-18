# 抖店后台顶部导航栏精确 DOM 结构

抓取于 2026-07-15（47KB 完整 HTML + 截图），用于 step5/step6/step7 定位顶部站点标签与品牌切换入口。**class hash 后缀随前端版本变化，切勿写死，一律用模糊匹配。**

## 容器
- `div#fxg-pc-header`，class `nav-menu_normalHeader__3Yjix`，约 1583×64px，固定在 `y=0` 顶栏。

## 左侧
- `h1#fxg-pc-header-title` = **抖店** Logo。
- `.nav-menu_search__1m2UL` = 搜索框，placeholder「智能搜索」。

## 中间「其他站点」导航项（点击进入独立站点）
每个 = `div.index_menuItem__1DJRt`，**React onClick，无 `<a href>`**，带 `data-guide` / `data-btm-id` 埋点：
1. **精选联盟** `data-guide="tabBar-精选联盟"` → 新标签 `buyin.jinritemai.com/dashboard`
2. **电商罗盘** `data-guide="tabBar-电商罗盘"` → 新标签 `compass.jinritemai.com`
3. **服务市场** `data-guide="tabBar-服务市场"`
4. **学习中心** `data-guide="tabBar-学习中心"`

定位方式：用 `document.querySelectorAll('*')` 遍历文本匹配「精选联盟」/「电商罗盘」，取 `getBoundingClientRect()` 中心点做真实鼠标点击（坐标约 `(927,22)` 电商罗盘、`(868,22)` 等，随布局可能微调）。

## 右侧
🔔 通知铃铛(with badge) | 📋 面板 | ➕ 加号 | 👤 头像 | **店铺名 ▾**(切换入口) | 「抖音电商」徽章 | **添加小二**

- 店铺名（品牌）元素：`class="index_userName__16Isl"`（**hash 后缀随前端版本变化，勿写死，用 `[class*="index_userName"]` 模糊匹配**）。hover 后出现下拉 → 点「切换组织/店铺」→ 弹窗中选目标店铺。

## ⚠️ 关键坑：搜索框焦点抢夺顶栏
- 搜索框一旦获得焦点，「其他站点」顶栏标签会被 AI 助手浮窗/搜索建议层遮挡而消失，导致 step5/step6 报 `NO_BUYIN_TAB` / `NOT_FOUND: 电商罗盘`。
- **修复**：在点击顶部导航标签前，先点页面空白区（如 `(800,200)`）解除搜索框焦点，再 `sleep` 等待 DOM 稳定后操作。step5/step6 已内置此逻辑。
