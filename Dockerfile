# ---- Build stage ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

# Only production dependencies in the final image.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output (includes compiled migrations under dist/db/migrations).
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 4000
# Run pending migrations, then start the server.
ENTRYPOINT ["./docker-entrypoint.sh"]
