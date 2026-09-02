#!/bin/bash
#
# Spark 電子ブックを作り直して公開する。
# Finder でこのファイルをダブルクリックすれば動きます。
#

# Finder から起動すると Homebrew の場所が入っていないことがあるので足す
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export LANG=ja_JP.UTF-8

cd "$(dirname "$0")" || exit 1

echo "================================================"
echo "  Spark 電子ブック  公開"
echo "================================================"
echo

# --- 道具がそろっているか ---
for cmd in node git pdftoppm pdfinfo; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "★ $cmd が見つかりません。"
    echo "  pdftoppm / pdfinfo が無い場合は、ターミナルで  brew install poppler"
    echo
    read -n 1 -s -r -p "何かキーを押すと閉じます"
    exit 1
  fi
done

# --- ① 作り直す ---
echo "【1/3】 PDF を読み込んで作り直しています…"
echo
if ! node build.mjs; then
  echo
  echo "★ 作り直しに失敗しました。上の赤い文字を立川さんへ見せてください。"
  echo
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 1
fi
echo

# --- ② 変わったところがあるか ---
if [ -z "$(git status --porcelain)" ]; then
  echo "【2/3】 変わったところはありませんでした。公開ずみの内容と同じです。"
  echo
  echo "  https://dj77tac-ai.github.io/miraicco-spark/"
  echo
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 0
fi

echo "【2/3】 変わったところ:"
git status --porcelain | sed 's/^/    /' | head -20
count=$(git status --porcelain | wc -l | tr -d ' ')
[ "$count" -gt 20 ] && echo "    … ほか $((count - 20)) 件"
echo

# --- ③ 公開する ---
echo "【3/3】 公開しています…"
git add -A
git commit -q -m "Spark 電子ブックの更新 ($(date '+%Y-%m-%d %H:%M'))"
if ! git push -q origin main; then
  echo
  echo "★ 公開に失敗しました。インターネットにつながっているか確かめてください。"
  echo
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 1
fi

echo
echo "================================================"
echo "  公開しました。1〜2分で反映されます。"
echo
echo "  https://dj77tac-ai.github.io/miraicco-spark/"
echo "================================================"
echo
echo "※ すぐ見に行って古いままでも、少し待って開き直せば新しくなります。"
echo
read -n 1 -s -r -p "何かキーを押すと閉じます"
