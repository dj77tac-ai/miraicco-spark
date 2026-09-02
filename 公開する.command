#!/bin/bash
#
# Spark 電子ブックを公開する。
# Finder でこのファイルをダブルクリックすれば動きます。
#

# Finder から起動すると Homebrew の場所が入っていないことがあるので足す
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export LANG=ja_JP.UTF-8

cd "$(dirname "$0")" || exit 1

# --- 道具がそろっているか ---
missing=""
for cmd in node git pdftoppm pdfinfo; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done

if [ -n "$missing" ]; then
  echo "★ 次のものが入っていません:$missing"
  echo
  echo "  はじめて使うパソコンだと思います。"
  echo "  「別のパソコンで使えるようにする.md」を見て、準備をしてください。"
  echo
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 1
fi

# --- パスワードのファイルがあるか ---
if [ ! -f password.txt ]; then
  echo "★ password.txt がありません。"
  echo
  echo "  Spark を暗号化するためのパスワードが必要です。"
  echo "  「別のパソコンで使えるようにする.md」の【3】を見てください。"
  echo
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 1
fi

# --- 最新の状態にしてから始める（他の人が先に出していた場合にそなえて） ---
git pull -q --rebase origin main </dev/null >/dev/null 2>&1

node publish.mjs
code=$?

echo
read -n 1 -s -r -p "何かキーを押すと閉じます"
exit $code
