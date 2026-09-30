#!/bin/sh
set -e

echo "→ Running database migrations…"
npm run migrate

echo "→ Starting MyBizPush Dev Space API…"
exec node dist/index.js
