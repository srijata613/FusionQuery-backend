# ─────────────────────────────────────────────
#  Stage 1: Builder
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies only (cache layer)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# ─────────────────────────────────────────────
#  Stage 2: Runtime
# ─────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: run as non-root
RUN addgroup -S trustchain && adduser -S trustchain -G trustchain

WORKDIR /app

# Copy from builder
COPY --from=builder --chown=trustchain:trustchain /app/node_modules ./node_modules
COPY --chown=trustchain:trustchain . .

# Create log directory
RUN mkdir -p logs && chown trustchain:trustchain logs

USER trustchain

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
