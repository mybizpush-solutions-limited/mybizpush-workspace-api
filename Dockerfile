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

# pg_dump for the database-backup console. Bookworm ships client 15, which
# refuses to dump a newer server ("server version X; pg_dump version 15"), so we
# pull 17 from PGDG — it can dump every server from 13 up.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
ENV PG_DUMP_PATH=/usr/lib/postgresql/17/bin/pg_dump

# Backups that are too large for Cloudinary land here, so it must be a volume —
# otherwise they disappear with the container.
ENV BACKUP_STORAGE_DIR=/var/lib/mybizpush/backups
RUN mkdir -p /var/lib/mybizpush/backups
VOLUME ["/var/lib/mybizpush/backups"]

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
