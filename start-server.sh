#!/bin/zsh
# launchd 启动包装：在真正的 shell 里设好 UTF-8 locale 并切到项目目录，用相对路径避免中文路径编码坑
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
cd "/Users/liutong/Documents/token消耗榜" || exit 1
exec /opt/homebrew/bin/node --env-file-if-exists=.env apps/server/src/server.mjs
