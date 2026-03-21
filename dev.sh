#!/usr/bin/env bash
set -e

# Ensure data directory exists for SQLite
mkdir -p data

PUBLIC_DEV=${PUBLIC_DEV:-0}

SERVER_PORT=${PORT:-3000}
SERVER_WEB_MODE=${WEB_MODE:-disabled}
SERVER_VITE_ORIGIN=${VITE_DEV_ORIGIN:-http://localhost:5173}

if [ "$PUBLIC_DEV" = "1" ]; then
  SERVER_PORT=8787
  SERVER_WEB_MODE=proxy
  SERVER_VITE_ORIGIN=http://localhost:5173
fi

cleanup() {
  printf "\n"
  echo "Shutting down..."
  kill $SERVER_PID $WEB_PID 2>/dev/null
  wait $SERVER_PID $WEB_PID 2>/dev/null
  echo "Done."
}

trap cleanup EXIT INT TERM

# Start backend server
PORT=$SERVER_PORT WEB_MODE=$SERVER_WEB_MODE VITE_DEV_ORIGIN=$SERVER_VITE_ORIGIN npx tsx packages/server/src/index.ts > server.log 2>&1 &
SERVER_PID=$!

# Start frontend dev server
npm run dev --prefix packages/web > web.log 2>&1 &
WEB_PID=$!

sleep 1

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "Server failed to start. Check server.log"
  exit 1
fi

if ! kill -0 $WEB_PID 2>/dev/null; then
  echo "Frontend failed to start. Check web.log"
  exit 1
fi

if [ "$PUBLIC_DEV" = "1" ]; then
  echo "App:     http://localhost:$SERVER_PORT"
else
  echo "Backend: http://localhost:$SERVER_PORT"
fi
echo "Vite:    http://localhost:5173"
echo "Press Ctrl+C to stop both."

wait
