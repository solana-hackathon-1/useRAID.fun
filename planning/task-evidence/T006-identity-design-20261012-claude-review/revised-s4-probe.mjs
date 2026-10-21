// Claude independent review of the REVISED T006/T007 lock design (design-reconciliation.md).
// Disposable PG16 only (DATABASE_URL). Read-only against repository source. Untruncated errors and
// pg_blocking_pids traces are retained (the first review truncated errors to 160 chars).
import { createRequire } from 'node:module';
const require = createRequire('/Users/dushyant/Documents/useRAID.fun/package.json');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const mon = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
const rnd = () => Math.random().toString(36).slice(2, 9);
const mkUser = async (tag) => (await db.user.create({ data: { handle: `p_${tag}_${rnd()}` } })).id;
const sess = (userId) => ({ tokenHash: `t_${rnd()}${rnd()}`, userId, expiresAt: new Date(Date.now() + 3600e3) });
const fullErr = (e) => ({
  name: e?.name,
  prismaCode: e?.code,
  meta: e?.meta ?? null,
  sqlstate: /40P01|55P03|23503|23505|40001/.exec(JSON.stringify(e?.meta ?? {}) + String(e?.message))?.[0] ?? null,
  message: String(e?.message ?? e),
});

// Sample blocked backends: who waits for whom, with query text, deduplicated.
function startTrace() {
  const seen = new Map();
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const rows = await mon.$queryRawUnsafe(`
          SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, wait_event, left(query, 140) AS query
          FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`);
        for (const r of rows) {
          const k = `${r.pid}<-${r.blockers.join(',')}|${r.wait_event_type}/${r.wait_event}`;
          if (!seen.has(k)) seen.set(k, { waiter: r.pid, blockedBy: r.blockers, wait: `${r.wait_event_type}/${r.wait_event}`, query: r.query });
        }
      } catch {}
      await sleep(20);
    }
  })();
  return async () => {
    stop = true;
    await loop;
    return [...seen.values()];
  };
}

// Run named transactions concurrently; each fn receives (tx, pid). Returns per-tx outcome.
async function run(label, specs) {
  console.error('RUN', label);
  const stopTrace = startTrace();
  const results = {};
  await Promise.all(
    specs.map(async ([name, fn]) => {
      const rec = { status: 'ok', pid: null, notes: {} };
      results[name] = rec;
      try {
        await db.$transaction(
          async (tx) => {
            rec.pid = (await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
            await fn(tx, rec.notes);
          },
          { timeout: 20000, maxWait: 5000 },
        );
      } catch (e) {
        rec.status = 'ERROR';
        rec.error = fullErr(e);
      }
    }),
  );
  return { label, results, waitTrace: await stopTrace() };
}

const out = { postgres: (await db.$queryRawUnsafe('select version() v'))[0].v, scenarios: {} };


async function s4(rootMode) {
  const d = await mkUser('s4');
  const writerIn = gate();
  const r = await run(`S4 merge root FOR ${rootMode} vs unlocked UsdcTransfer insert`, [
    ['financeWriter(no balance advisory lock)', async (tx) => {
      try {
        await tx.usdcTransfer.create({ data: { userId: d, kind: 'DEPOSIT', amount: 1n, walletAddress: 'w' + rnd(), recipient: 'r' + rnd(), network: 'devnet', mint: 'm' } });
      } finally { writerIn.open(); }
      await sleep(600);
    }],
    ['merge', async (tx, n) => {
      await writerIn.p;
      await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${d}' FOR ${rootMode}`);
      n.rowsVisibleToEmptinessCheck = await tx.usdcTransfer.count({ where: { userId: d } });
      await tx.user.delete({ where: { id: d } });
    }],
  ]);
  r.final = { dropAccountStillExists: !!(await db.user.findUnique({ where: { id: d } })), transferRows: await db.usdcTransfer.count({ where: { userId: d } }) };
  return r;
}
out.scenarios.S4_noKeyUpdate = await s4('NO KEY UPDATE');
out.scenarios.S4_forUpdate = await s4('UPDATE');
await mon.$disconnect(); await db.$disconnect();
console.log(JSON.stringify(out, null, 2));
