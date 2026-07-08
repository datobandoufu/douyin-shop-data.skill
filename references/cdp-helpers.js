# CDP 可复用 JS 片段

这些代码片段通过 `Runtime.evaluate` 注入到浏览器页面中执行。

## 1. selectYesterdayTime() — 设置时间为昨天

选中 `value=one`（近1天）的 radio 按钮。适用于商品列表和达人列表页面。

**调用方式**：直接作为 `Runtime.evaluate` 的 `expression` 执行。

```js
(function() {
  var inp = document.querySelector('input[type=radio][value=one]');
  if (!inp) return 'NO_RADIO_ONE';
  var r = inp.getBoundingClientRect();
  var cx = r.left + r.width / 2;
  var cy = r.top + r.height / 2;
  var opts = { bubbles: true, cancelable: true, view: window };

  inp.dispatchEvent(new MouseEvent('mousedown', Object.assign({ clientX: cx, clientY: cy, button: 0 }, opts)));
  inp.dispatchEvent(new MouseEvent('mouseup',   Object.assign({ clientX: cx, clientY: cy, button: 0 }, opts)));
  inp.dispatchEvent(new MouseEvent('click',     Object.assign({ clientX: cx, clientY: cy, button: 0 }, opts)));
  inp.dispatchEvent(new Event('change', { bubbles: true }));

  // Verify
  var active = document.querySelector('.ecom-radio-button-wrapper-checked');
  return active ? 'OK ' + active.textContent.trim() : 'FAIL_TO_VERIFY';
})()
```

## 2. openProductDownloadDropdown() — 打开商品列表下载下拉

通过 `.downloadDrop-kGtGGo` 按钮的 fiber D5 `onPopupVisibleChange` 打开下拉菜单。

```js
(function() {
  var btn = document.querySelector('.downloadDrop-kGtGGo');
  if (!btn) return 'NO_DOWNLOAD_BTN';

  var fiberKey = Object.keys(btn).find(function(k) { return k.startsWith('__reactFiber'); });
  if (!fiberKey) return 'NO_FIBER_ON_BTN';

  var fiber = btn[fiberKey];
  var node = fiber;
  for (var i = 0; i < 5; i++) node = node.return;

  if (node.memoizedProps && typeof node.memoizedProps.onPopupVisibleChange === 'function') {
    node.memoizedProps.onPopupVisibleChange(true);
    return 'OPENED';
  }

  return 'NO_POPUP_HANDLER';
})()
```

## 3. clickDropdownItem(text) — 点击下拉菜单项

在下拉菜单已打开的前提下，通过 fiber onClick 点击指定文本的菜单项。

```js
(function() {
  var targetText = '下载当前明细'; // 可替换为目标文本

  var items = document.querySelectorAll('.ecom-dropdown-menu-item');
  for (var i = 0; i < items.length; i++) {
    if (items[i].textContent.indexOf(targetText) >= 0) {
      var fiberKey = Object.keys(items[i]).find(function(k) { return k.startsWith('__reactFiber'); });
      if (!fiberKey) return 'NO_FIBER_ON_ITEM';

      var fiber = items[i][fiberKey];
      var node = fiber;
      while (node) {
        if (node.memoizedProps && typeof node.memoizedProps.onClick === 'function') {
          node.memoizedProps.onClick({
            stopPropagation: function() {},
            preventDefault: function() {},
            nativeEvent: new MouseEvent('click')
          });
          return 'CLICKED';
        }
        node = node.return;
      }

      items[i].click();
      return 'DOM_CLICKED';
    }
  }
  return 'ITEM_NOT_FOUND: ' + targetText;
})()
```

## 4. triggerInfluencerDownload() — 触发达人列表下载

通过 `.withTooltip-lLfGho` 按钮的 fiber D8 `onDownload` 触发下载请求。

```js
(function() {
  var btn = document.querySelector('.withTooltip-lLfGho');
  if (!btn) return 'NO_DL_BTN';

  var fiberKey = Object.keys(btn).find(function(k) { return k.startsWith('__reactFiber'); });
  if (!fiberKey) return 'NO_FIBER';

  var fiber = btn[fiberKey];
  var node = fiber;
  for (var i = 0; i < 8; i++) node = node.return;

  if (node.memoizedProps && typeof node.memoizedProps.onDownload === 'function') {
    node.memoizedProps.onDownload();
    return 'TRIGGERED';
  }

  return 'NO_ONDOWNLOAD_HANDLER';
})()
```

## 5. 通用 findAndCallFiber(selector, handlerName, depth)

通用的 fiber 遍历工具，从匹配选择器的元素向上遍历 fiber 树，找到并调用指定 handler。

```js
function findAndCallFiber(selector, handlerName, depth) {
  var el = document.querySelector(selector);
  if (!el) return { error: 'ELEMENT_NOT_FOUND', selector: selector };

  var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber'); });
  if (!fiberKey) return { error: 'NO_FIBER', selector: selector };

  var fiber = el[fiberKey];

  // If depth specified, go exactly that many levels up
  if (typeof depth === 'number') {
    var node = fiber;
    for (var i = 0; i < depth; i++) {
      if (!node) return { error: 'DEPTH_EXCEEDED', reached: i, target: depth };
      node = node.return;
    }
    if (node.memoizedProps && typeof node.memoizedProps[handlerName] === 'function') {
      node.memoizedProps[handlerName]();
      return { success: true, handler: handlerName, depth: depth };
    }
    return { error: 'HANDLER_NOT_FOUND_AT_DEPTH', handler: handlerName, depth: depth };
  }

  // Otherwise walk up until found
  var node = fiber;
  var d = 0;
  while (node && d < 30) {
    if (node.memoizedProps && typeof node.memoizedProps[handlerName] === 'function') {
      node.memoizedProps[handlerName]();
      return { success: true, handler: handlerName, depth: d };
    }
    node = node.return;
    d++;
  }
  return { error: 'HANDLER_NOT_FOUND', handler: handlerName, searched: d };
}
```

用法示例：
```js
// 打开商品下拉
findAndCallFiber('.downloadDrop-kGtGGo', 'onPopupVisibleChange', 5);

// 触发达人下载
findAndCallFiber('.withTooltip-lLfGho', 'onDownload', 8);
```
