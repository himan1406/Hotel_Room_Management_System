#!/bin/sh
set -e

echo "[startup] Installing frontend npm dependencies..."

cd /app/frontend

# Install deps fresh inside the container (the host's node_modules
# contains Windows binaries and is excluded via anonymous volume).
npm install

echo "[startup] Building frontend JS bundle..."
node build.js

echo "[startup] Frontend bundle built."

cd /app

echo "[startup] Running database migrations..."
alembic upgrade head
echo "[startup] Migrations complete."

echo "[startup] Starting server..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
