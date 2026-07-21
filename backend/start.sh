#!/bin/sh
set -e

echo "[startup] Building frontend JS bundle..."

cd /app/frontend

# esbuild is installed globally in the Docker image, so node build.js
# works without needing node_modules from the host volume mount.
node build.js

echo "[startup] Frontend bundle built."

cd /app

echo "[startup] Running database migrations..."
alembic upgrade head
echo "[startup] Migrations complete."

echo "[startup] Starting server..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
