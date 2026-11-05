# Independent product-metrics host

Consumes the portable `metrics/contracts`, `metrics/storage` and `metrics/http` modules (plus shared `contracts` and the `command-receipts` transaction type). See the [module contract](../../docs/raid-metrics.md). Requires Node 22.12+ and a new empty loopback PostgreSQL 16 database named `raid_metrics_example`; `DATABASE_URL` is its only configuration. It creates its own minimal tables (the eight tables, with only the columns the metrics read,) and synthetic rows inside one transaction, so it never touches the application database.

```sh
cp -RL examples/metrics /tmp/raid-metrics-host   # dereference the canonical module symlinks
cd /tmp/raid-metrics-host
npm install --ignore-scripts --no-audit --no-fund
DATABASE_URL=postgresql://.../raid_metrics_example npm start
```

Expected JSON: `synthetic` and every check `true` (flag off is absent, a non-operator is forbidden, a query-string scope is refused, the operator read is private and uncacheable, ratios carry numerator and denominator, a newcomer is only in the denominator, work under an unpersisted Guild id is excluded, and no money, valuation or account appears). No production authority or live funding is implied. Stop and remove the owned database after testing; preserve unrelated resources.
