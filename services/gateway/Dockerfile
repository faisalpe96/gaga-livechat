# =============================================================================
# DOCKERFILE: CHAT GATEWAY (spec/09-produksi.md Bagian 3 & 4)
# Stateful WebSocket server dengan koneksi sticky session & migrasi otomatis
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build & Dependencies
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install system dependencies if required for native addons
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy root dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsx)
RUN npm ci

# Copy application sources needed for gateway, migrations, and scripts
COPY tsconfig.json ./
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY data/ ./data/
COPY services/gateway/ ./services/gateway/

# -----------------------------------------------------------------------------
# Stage 2: Production Runtime
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Set production environment flags
ENV NODE_ENV=production
ENV PORT=3001
ENV ENFORCE_AUTH=true

# Create unprivileged user for security
RUN groupadd -r gaga && useradd -r -g gaga -m -d /home/gaga gaga

# Create persistent directory for temporary uploads/attachments
RUN mkdir -p /app/storage/attachments /app/storage/tmp && \
    chown -R gaga:gaga /app/storage

# Copy installed node_modules and code from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/data ./data
COPY --from=builder /app/services/gateway ./services/gateway

# Assign ownership to gaga user
RUN chown -R gaga:gaga /app

USER gaga

# Expose port (default 3001)
EXPOSE 3001

# Healthcheck probe (Railway / Docker engine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3001) + '/health/live').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Jalankan migrasi database otomatis saat deploy lalu jalankan Gateway
CMD ["sh", "-c", "npx tsx scripts/deploy-migrate.ts && npx tsx services/gateway/src/index.ts"]
