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

# pg_dump for the database-backup console.
#
# pg_dump refuses to dump a server NEWER than itself ("aborting because of
# server version mismatch"), so this must be >= the highest server version we
# back up. Bookworm's own package is 15, hence PGDG. Bump PG_MAJOR when we start
# running a newer Postgres anywhere — an older client is a hard failure, while a
# newer client dumps older servers fine.
ARG PG_MAJOR=18
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
ENV PG_MAJOR=${PG_MAJOR}
ENV PG_DUMP_PATH=/usr/lib/postgresql/${PG_MAJOR}/bin/pg_dump

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
