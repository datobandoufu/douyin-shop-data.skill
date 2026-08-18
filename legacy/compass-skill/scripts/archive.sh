#!/bin/bash
# Archive downloaded Excel file to project folder
# Usage: ./archive.sh <type: 商品列表|达人列表> [date: YYYYMMDD] [brand: 品牌A]
#   输出目录可用环境变量 PROJECT_DIR 覆盖（默认当前目录）
#   注意：交易明细（成交分析）已改用 transaction-download.mjs 的快照法归档，不走本脚本。
#
# Examples:
#   ./archive.sh 商品列表
#   ./archive.sh 达人列表 20260706
#   ./archive.sh 商品列表 20260706 品牌B

set -e

TYPE="${1:-}"
DATE="${2:-$(date -d 'yesterday' '+%Y%m%d')}"
BRAND="${3:-品牌A}"
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
DOWNLOADS_DIR="$HOME/Downloads"
TARGET_DIR="$PROJECT_DIR/$DATE"
TARGET_FILE="$TARGET_DIR/${DATE}_${BRAND}_${TYPE}.xlsx"

if [ -z "$TYPE" ]; then
    echo "Usage: $0 <商品列表|达人列表> [YYYYMMDD]"
    exit 1
fi

# Find the most recently downloaded Excel file matching the pattern
case "$TYPE" in
    商品列表)
        PATTERN="经营版_商品_商品列表__*${DATE}*.xlsx"
        SOURCE_PATTERN="经营版_商品_商品列表__*-*_数据更新时间*.xlsx"
        ;;
    达人列表)
        SOURCE_PATTERN="*.xlsx"
        ;;
    *)
        echo "Error: Unknown type '$TYPE'. Must be 商品列表 or 达人列表"
        exit 1
        ;;
esac

echo "[1/3] Looking for downloaded file..."
LATEST=$(ls -t "$DOWNLOADS_DIR"/$SOURCE_PATTERN 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
    echo "Error: No matching Excel file found in $DOWNLOADS_DIR"
    echo "  Pattern: $SOURCE_PATTERN"
    exit 1
fi

echo "  Found: $LATEST"

echo "[2/3] Creating target directory: $TARGET_DIR"
mkdir -p "$TARGET_DIR"

echo "[3/3] Moving and renaming..."
cp "$LATEST" "$TARGET_FILE"

echo "  Done: $TARGET_FILE"
echo "  Size: $(stat -c%s "$TARGET_FILE" 2>/dev/null || echo 'unknown') bytes"
