FROM python:3.11-slim

WORKDIR /app

# ── System dependencies ───────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq-dev gcc \
        nodejs npm && \
    rm -rf /var/lib/apt/lists/*

# ── Install esbuild globally (avoids Windows/Linux binary conflict ═
#    from volume-mounted host node_modules) ──────────────────────
RUN npm install -g esbuild

# ── Python dependencies ───────────────────────────────────────
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Backend source code (includes start.sh) ──────────────────
COPY backend/ .
RUN chmod +x start.sh

EXPOSE 8000

CMD ["./start.sh"]
