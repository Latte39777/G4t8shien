#!/usr/bin/env bash
# 結果画面スクリーンショット撮影（M7-K 前後記録用・検証専用）
# 使い方: scripts/shot.sh <HTMLファイル> <出力ディレクトリ>
# 備考: headless Chromium の共有ライブラリはユーザー領域（/tmp/pwdeps）に展開済み。
set -euo pipefail
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-/tmp/pwdeps/root/usr/lib/x86_64-linux-gnu}"
HTML="$1"
OUT="$2"
mkdir -p "$OUT"
URL="file://$(realpath "$HTML")"
npx -y playwright@1.64.1 screenshot --viewport-size="390,844" --full-page --wait-for-timeout=1500 "$URL" "$OUT/mobile-390.png"
npx -y playwright@1.64.1 screenshot --viewport-size="390,844" --full-page --wait-for-timeout=1500 "$URL#expanded" "$OUT/mobile-390-expanded.png"
npx -y playwright@1.64.1 screenshot --viewport-size="1280,900" --full-page --wait-for-timeout=1500 "$URL" "$OUT/pc-1280.png"
npx -y playwright@1.64.1 screenshot --viewport-size="1280,900" --full-page --wait-for-timeout=1500 "$URL#expanded" "$OUT/pc-1280-expanded.png"
echo "screenshots saved to $OUT"