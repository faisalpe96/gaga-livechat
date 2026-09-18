# =============================================================================
# DOCKERFILE: AI ORCHESTRATOR (spec/09-produksi.md Bagian 3 & 4)
# Stateless AI pipeline server (Intent, KB Retriever, Guardrails, LLM)
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build & Dependencies
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy root dependency manifests
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy application sources needed for orchestrator
COPY tsconfig.json ./
COPY data/ ./data/
COPY scripts/ ./scripts/
COPY services/orchestrator/ ./services/orchestrator/

# -----------------------------------------------------------------------------
# Stage 2: Production Runtime
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Set production environment flags
ENV NODE_ENV=production
ENV ORCHESTRATOR_PORT=3003
ENV PORT=3003

# Create unprivileged user for security
RUN groupadd -r gaga && useradd -r -g gaga -m -d /home/gaga gaga

# Copy installed node_modules and code from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/data ./data
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/services/orchestrator ./services/orchestrator

# Assign ownership to gaga user
RUN chown -R gaga:gaga /app

USER gaga

# Expose orchestrator port (default 3003)
EXPOSE 3003

# Healthcheck probe (Railway / Docker engine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3003) + '/health/live').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Jalankan AI Orchestrator service
CMD ["npx", "tsx", "services/orchestrator/src/index.ts"]
