#!/usr/bin/env bash
# 清理 Tauri 构建残留的 DMG 挂载卷和临时文件
# 用法: bash scripts/clean-dmg.sh

set -e

BUNDLE_DIR="src-tauri/target/release/bundle"

echo "==> 检查残留的 DMG 挂载卷..."

detached=0
while IFS= read -r dev; do
  [[ -z "$dev" ]] && continue
  echo "    卸载 $dev"
  hdiutil detach "$dev" -force 2>/dev/null && ((detached++)) || true
done < <(hdiutil info 2>/dev/null | grep -B 20 "$BUNDLE_DIR" | grep -E '^/dev/disk' | awk '{print $1}' | sort -u)

if [[ $detached -eq 0 ]]; then
  echo "    没有发现残留挂载卷"
else
  echo "    已卸载 $detached 个卷"
fi

echo "==> 清理临时 DMG 文件..."
count=0
for f in "$BUNDLE_DIR"/macos/rw.*.dmg "$BUNDLE_DIR"/dmg/rw.*.dmg; do
  [[ -f "$f" ]] || continue
  echo "    删除 $f"
  rm -f "$f"
  ((count++))
done

if [[ $count -eq 0 ]]; then
  echo "    没有发现临时文件"
else
  echo "    已删除 $count 个临时文件"
fi

echo "==> 清理完成!"
