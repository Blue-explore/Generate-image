#!/usr/bin/env bash
# 用法: ./install.sh [profile]   （默认 web；也支持 desktop / headless）
set -euo pipefail

PROFILE="${1:-web}"
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 需要 Node.js 18+（fetch / AbortSignal.timeout）" >&2
  exit 1
fi
if ! command -v dsh >/dev/null 2>&1; then
  echo "✗ 找不到 dsh 命令，先装 DeepSeek Harness：npm i -g @deepseek-ai/dsh" >&2
  exit 1
fi

exec node install.mjs "$PROFILE" "${@:2}"
