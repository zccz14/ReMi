#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p data
npm run build:web

DEFAULT_WEB_DIST_DIR="$(cd packages/web/dist && pwd)"
if [ "${WEB_DIST_DIR+x}" != "x" ]; then
  :
else
  WEB_DIST_DIR="$DEFAULT_WEB_DIST_DIR"
fi
export WEB_DIST_DIR
export WEB_MODE=static

exec npx tsx packages/server/src/index.ts
