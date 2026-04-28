# BLOB CHAIN node Dockerfile.
# Builds a slim runtime image. SQLite data lives on /data (mount a volume).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 needs build tools. Install, build deps, then drop them.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/blobchain.db
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data
COPY --from=deps /app/node_modules ./node_modules
COPY . .
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1
CMD ["npx", "tsx", "full-node.ts"]
