# React 受控组件操作模式

抖店后台使用 `@ecomelement/ui` (字节跳动 UI 组件库)，页面为 React SPA。常规 `element.click()` 和 CDP mouse event 均无法触发 React 状态变更。

## 通用策略优先级

1. **dispatchEvent + MouseEvent 链** → 适用于 ecom-radio-group（无需 fiber）
2. **React fiber onPopupVisibleChange** → 适用于商品列表下载按钮（`.downloadDrop-kGtGGo`）打开下拉菜单
3. **React fiber onClick** → 适用于 dropdown 菜单项点击
4. **React fiber onDownload + CDP Network** → 适用于直接下载按钮（无 dropdown）

---

## 模式 1: ecom-radio-group（时间筛选）

适用组件：`ecom-radio-group-outline` 中的 `ecom-radio-button-wrapper`

**常规方式失败原因**：React 合成事件系统（SyntheticEvent）不响应程序化 click。

**解决方案**：在 `<input type=radio>` 上派发完整的原生 MouseEvent 链，必须包含 `clientX/clientY`：

```js
var inp = document.querySelector('input[type=radio][value=one]'); // value=one 即 近1天
var r = inp.getBoundingClientRect();
var cx = r.left + r.width/2;
var cy = r.top + r.height/2;
var opts = {bubbles: true, cancelable: true, view: window};

inp.dispatchEvent(new MouseEvent('mousedown', Object.assign({clientX: cx, clientY: cy, button: 0}, opts)));
inp.dispatchEvent(new MouseEvent('mouseup',   Object.assign({clientX: cx, clientY: cy, button: 0}, opts)));
inp.dispatchEvent(new MouseEvent('click',     Object.assign({clientX: cx, clientY: cy, button: 0}, opts)));
inp.dispatchEvent(new Event('change', {bubbles: true}));
```

**radio value 映射**：
| value | 含义 |
|-------|------|
| `realTime` | 实时 |
| `one` | 近1天 |
| `seven` | 近7天 |
| `thirty` | 近30天 |
| `day` | 自然日 |
| `week` | 自然周 |
| `month` | 自然月 |

**验证**：检查 `ecom-radio-button-wrapper-checked` 类是否出现在目标 label 上。

---

## 模式 2: 商品列表下载按钮 — 打开下拉菜单

适用组件：`.downloadDrop-kGtGGo`（`ecom-btn ecom-dropdown-trigger`）

**关键发现**：`.ecom-dropdown` 父容器在页面当前状态中**不存在**。不能通过查找 `.ecom-dropdown` 的 fiber 来操作。下拉菜单的开关由按钮的 React fiber 树上 D5 节点的 `onPopupVisibleChange` 控制。

**打开下拉菜单**：

```js
var btn = document.querySelector('.downloadDrop-kGtGGo');
var fiberKey = Object.keys(btn).find(function(k){ return k.startsWith('__reactFiber'); });
var fiber = btn[fiberKey];

// 向上 5 层到 onPopupVisibleChange handler
var node = fiber;
for (var i = 0; i < 5; i++) node = node.return;

if (node.memoizedProps && typeof node.memoizedProps.onPopupVisibleChange === 'function') {
  node.memoizedProps.onPopupVisibleChange(true);  // 打开下拉
}
```

**关闭下拉菜单**：调用 `onPopupVisibleChange(false)`。

### 商品列表下载按钮 Fiber 树

| 深度 | tag | 关键 handlers |
|------|-----|-------------|
| 0 | 5 (host) | onClick, onMouseEnter, onMouseLeave |
| 3 | 11 | onMouseEnter, onMouseLeave |
| 5 | 1 | **onPopupVisibleChange**, onPopupAlign ← 下拉开关 |
| 6 | 11 | (state wrapper) |
| ... | ... | ... |

**注意**：fiber 树结构可能因 ecom-element 版本不同而变化。优先使用 `onPopupVisibleChange` 方案（遍历 fiber 找该 handler），fallback 可尝试查找 `.ecom-dropdown` + useState dispatch。

---

## 模式 3: Dropdown 菜单项点击

适用组件：`.ecom-dropdown-menu-item`

**问题**：`click()` 和 CDP mouse 均不触发，菜单可能处于负 Y 坐标（上方弹出）。

**解决方案**：
1. 用模式 2 打开下拉
2. 先 `scrollIntoView({block:'start'})` 将按钮滚到视口顶部（让下拉能向下展开）
3. 关闭再重新打开下拉（让它在可见区域展开）
4. 通过 menu item 的 React fiber 调用 `onClick`：

```js
var item = document.querySelector('.ecom-dropdown-menu-item');
var fiberKey = Object.keys(item).find(k => k.startsWith('__reactFiber'));
var fiber = item[fiberKey];

var node = fiber;
while (node) {
  var props = node.memoizedProps || {};
  if (typeof props.onClick === 'function') {
    props.onClick({
      stopPropagation: function(){},
      preventDefault: function(){},
      nativeEvent: new MouseEvent('click')
    });
    break;
  }
  node = node.return;
}
```

**注意**：菜单项的 fiber onClick 在一次 eval 中可能不会立即生效，但如果文件出现在 Downloads 目录即说明已触发。

---

## 模式 4: 直接下载按钮（达人列表页）

适用组件：`.withTooltip-lLfGho`（`ecom-btn ecom-btn-default`，**无** `ecom-dropdown-trigger` 类）

**特征**：与商品列表页的下载按钮不同，达人列表页的下载按钮是一个直接按钮，hover 只显示"暂时仅支持单次下载1万行数据"提示，无下拉菜单。

**问题**：fiber `onClick`/`onDownload` 单独调用不产生文件下载（只发 API 请求但浏览器不保存）。

**解决方案**：通过 CDP `Network` 域拦截下载请求的响应体，手动保存文件。

### 完整流程

```js
// 1. 启用 Network 监控
ws.send(JSON.stringify({id: 1, method: 'Network.enable'}));

// 2. 监听 Network.requestWillBeSent，匹配 cooperage/list/download
// 3. 调用 fiber onDownload（深度 8）
var btn = document.querySelector('.withTooltip-lLfGho');
var fiberKey = Object.keys(btn).find(k => k.startsWith('__reactFiber'));
var fiber = btn[fiberKey];
var node = fiber;
for (var i = 0; i < 8; i++) node = node.return;
if (node.memoizedProps && typeof node.memoizedProps.onDownload === 'function') {
  node.memoizedProps.onDownload();  // 触发 API 请求
}

// 4. 监听 Network.loadingFinished（匹配 requestId）
// 5. 调用 Network.getResponseBody 获取 base64 编码的响应体
// 6. 解码并写入文件
fs.writeFileSync(path, Buffer.from(body.base64, 'base64'));
```

### Fiber 树结构

| 深度 | tag | 关键 handlers |
|------|-----|-------------|
| 0 | 5 (host) | onClick, onMouseEnter, onMouseLeave |
| 3 | 11 | onClick, onMouseEnter, onMouseLeave |
| 5 | 1 | onPopupVisibleChange, onPopupAlign |
| 6 | 11 | onVisibleChange, onPopupAlign |
| 8 | 0 | **onDownload** ← 调用此 handler 触发下载 API |
| 18 | 0 | onDownload（备用） |

### 下载 API 特征

- URL 模式：`compass.jinritemai.com/compass_api/shop/author/cooperate/list/download`
- 参数含 `end_date=2026%2F07%2F06`（URL 编码的日期）
- 响应：200 + base64 编码的 Excel 文件内容

---

## 模式 5: 店铺切换（切换数据视角）

适用场景：同一账号管理多店铺，在电商罗盘间切换品牌数据视角。

### 触发元素

```
右上角 .userDropDown-k9_W5P  (aurora-dropdown-trigger)
  └─ hover 出现下拉 .dropDownWrapper-ysUAKu
      ├─ .userName-zP35aZ          → 当前店铺名
      ├─ .switchAccount-jAhEuJ     → "切换数据视角"  (fiber D0 onClick)
      └─ "退出登录"
```

### 弹窗结构（点击切换数据视角后）

```
.auxo-modal-wrap (role=dialog, centered)
  └─ .index_roleList__2vLVk
      ├─ .index_roleItem__3R8yT (fiber D0 onClick)  → 店铺 A
      │   └─ .index_introName__2tsRs  → 店铺名
      └─ .index_roleItem__3R8yT (fiber D0 onClick)  → 店铺 B
          └─ .index_introName__2tsRs  → 店铺名
```

### 完整切换流程

```js
// 1. Hover 店铺名
var t = document.querySelector('.userDropDown-k9_W5P');
var r = t.getBoundingClientRect();
// CDP: Input.dispatchMouseEvent → mouseMoved, 1500ms

// 2. Fiber D0 点击 .switchAccount-jAhEuJ
var el = document.querySelector('.switchAccount-jAhEuJ');
var fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
var fiber = el[fiberKey];
fiber.memoizedProps.onClick({ stopPropagation(){}, preventDefault(){} });
// 等待 2000ms 弹窗出现

// 3. Fiber D0 点击目标品牌
var items = document.querySelectorAll('.index_roleItem__3R8yT');
for (var i = 0; i < items.length; i++) {
  var name = items[i].querySelector('.index_introName__2tsRs');
  if (name && name.textContent.indexOf('目标店铺名') >= 0) {
    var fk = Object.keys(items[i]).find(k => k.startsWith('__reactFiber'));
    items[i][fk].memoizedProps.onClick({ stopPropagation(){}, preventDefault(){} });
  }
}
// 等待 4000ms → 页面跳转 compass 首页

// 4. 验证: document.querySelector('.userName-zP35aZ').textContent
```

### 品牌映射

| 品牌简称 | 弹窗中文名 |
|---------|----------|
| `<品牌A简称>` | `<品牌A店铺全名>` |
| `<品牌B简称>` | `<品牌B店铺全名>` |

> 实际映射在 `scripts/config.js` 的 `BRAND_FULL_NAMES` 中配置。

**注意**：切换后页面回到 compass 首页，需重新导航到商品列表或达人列表。
