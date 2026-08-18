#!/usr/bin/env bash
# 一键打开带 9222 调试端口的 Chrome 并进入抖店后台
# 用法: bash open-chrome-doudian.sh
# DD_NODE / DD_SCRIPT 可用环境变量覆盖（默认 node + 本目录相对定位）
NODE="${DD_NODE:-node}"
SCRIPT="${DD_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/open-chrome-doudian.mjs}"
"$NODE" "$SCRIPT" "$@"
