#!/usr/bin/env bash
set -e

# Ensure data directory exists for SQLite
mkdir -p data

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $SERVER_PID $WEB_PID 2>/dev/null
  wait $SERVER_PID $WEB_PID 2>/dev/null
  echo "Done."
}

trap cleanup EXIT INT TERM

# Start backend server
npx tsx packages/server/src/index.ts &
SERVER_PID=$!

# Start frontend dev server
npm run dev --prefix packages/web &
WEB_PID=$!

echo "Backend:  http://localhost:${PORT:-3000}"
echo "Frontend: http://localhost:5173"
echo "Press Ctrl+C to stop both."

wait
