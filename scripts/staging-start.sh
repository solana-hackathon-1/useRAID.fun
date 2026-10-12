#!/bin/sh
# v1 startup contract: fail closed on migrations, then give Node PID 1/signals.
set -eu
case "${1:-}" in
  web|worker) role=$1 ;;
  *) printf '%s\n' 'Usage: staging-start.sh web|worker' >&2; exit 64 ;;
esac

# Prisma's database advisory lock serializes concurrent web/worker migrations.
# A failed/contended migration exits; Docker restarts, never serving stale schema.
npm run db:migrate
case "$role" in
  web) exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 ;;
  worker) exec node --import tsx src/worker.ts ;;
esac
