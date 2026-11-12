#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"

# Use a separate port so an existing localhost editor can keep running.
exec /bin/zsh ./启动手写答题.command --lan --port 8767 "$@"
