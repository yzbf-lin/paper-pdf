#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  print -u2 "未找到 Python 3。请安装 Python 3 后重新打开此文件。"
  read -r "?按回车关闭。"
  exit 1
fi

python3 server.py "$@" || {
  result=$?
  read -r "?按回车关闭。"
  exit "$result"
}
