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

// ---------- S1: R1 modification — KEY SHARE vs SHARE for read-only sign-in vs suspension ----------
async function s1(mode) {
  const u = await mkUser('s1');
  const locked = gate();
  const r = await run(`S1 sign-in root FOR ${mode} vs suspension`, [
    [
      'signin',
      async (tx, n) => {
        const row = (await tx.$queryRawUnsafe(`SELECT id, suspended FROM "User" WHERE id='${u}' FOR ${mode}`))[0];
        n.suspendedObserved = row.suspended;
        locked.open();
        await sleep(500);
        await tx.session.create({ data: sess(u) });
      },
    ],
    [
      'suspension',
      async (tx) => {
        await locked.p;
        await sleep(50);
        await tx.$executeRawUnsafe(`UPDATE "User" SET suspended = true WHERE id='${u}'`);
        await tx.$executeRawUnsafe(`DELETE FROM "Session" WHERE "userId"='${u}'`);
      },
    ],
  ]);
  const left = await db.session.count({ where: { userId: u } });
  const susp = (await db.user.findUnique({ where: { id: u } })).suspended;
  return { ...r, final: { suspended: susp, sessionsLeftForSuspendedAccount: left } };
}
out.scenarios.S1_keyshare = await s1('KEY SHARE');
out.scenarios.S1_share = await s1('SHARE');

// ---------- S2: X1 (root-less Session writer vs FOR UPDATE merge), both queue orders ----------
async function x1(writerKind, order) {
  const d = await mkUser('x1');
  const old = sess(d);
  await db.session.create({ data: old });
  const writerStarted = gate(), mergeRooted = gate();
  const writer = async (tx, n) => {
    if (order === 'mergeFirst') await mergeRooted.p;
    if (writerKind !== 'rootless') {
      const rows = await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${d}' FOR ${writerKind === 'share' ? 'SHARE' : 'KEY SHARE'}`);
      n.rootRows = rows.length;
      if (rows.length === 0) {
        n.planChanged = true; // account folded away while we waited
        writerStarted.open();
        return;
      }
    }
    await tx.$executeRawUnsafe(`DELETE FROM "Session" WHERE "tokenHash"='${old.tokenHash}'`);
    writerStarted.open();
    await sleep(200);
    await tx.session.create({ data: sess(d) });
  };
  const merge = async (tx) => {
    if (order === 'writerFirst') await writerStarted.p;
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${d}' FOR UPDATE`);
    mergeRooted.open();
    if (order === 'mergeFirst') await sleep(150);
    await tx.session.deleteMany({ where: { userId: d } });
    await tx.user.delete({ where: { id: d } });
  };
  return run(`X1 writer=${writerKind} order=${order}`, [['writer', writer], ['merge', merge]]);
}
out.scenarios.X1 = {};
for (const kind of ['rootless', 'keyshare', 'share'])
  for (const order of ['writerFirst', 'mergeFirst']) out.scenarios.X1[`${kind}/${order}`] = await x1(kind, order);

// ---------- S3: X2 multi-user FK writer unsorted vs sorted FOR UPDATE roots, both queue orders ----------
async function x2(writerKind, order) {
  const a = await mkUser('x2a'), b = await mkUser('x2b');
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const writerHoldsFirst = gate(), mergeHoldsLo = gate();
  const writer = async (tx) => {
    if (order === 'mergeFirst') await mergeHoldsLo.p;
    if (writerKind === 'sortedRoots') {
      await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${lo}' FOR KEY SHARE`);
      await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${hi}' FOR KEY SHARE`);
    }
    await tx.session.create({ data: sess(hi) }); // unsorted: hi then lo
    writerHoldsFirst.open();
    await sleep(250);
    await tx.session.create({ data: sess(lo) });
  };
  const merge = async (tx) => {
    if (order === 'writerFirst') await writerHoldsFirst.p;
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${lo}' FOR UPDATE`);
    mergeHoldsLo.open();
    if (order === 'mergeFirst') await sleep(100);
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${hi}' FOR UPDATE`);
  };
  return run(`X2 writer=${writerKind} order=${order}`, [['multiUserFkWriter', writer], ['sortedRootsMerge', merge]]);
}
out.scenarios.X2 = {};
for (const kind of ['unsortedFkInserts', 'sortedRoots'])
  for (const order of ['writerFirst', 'mergeFirst']) out.scenarios.X2[`${kind}/${order}`] = await x2(kind, order);

// ---------- S4: finance emptiness race — uncommitted ledger insert for the dropped account ----------
async function s4(rootMode) {
  const d = await mkUser('s4');
  const writerIn = gate();
  const r = await run(`S4 merge root FOR ${rootMode} vs unlocked BalanceEntry insert`, [
    [
      'financeWriter(no balance advisory lock)',
      async (tx) => {
        try {
          await tx.balanceEntry.create({
            data: { key: `s4:${rnd()}`, userId: d, kind: 'TEST_FUNDS', network: 'devnet', availableDelta: 1n, reservedDelta: 0n },
          });
        } finally {
          writerIn.open();
        }
        await sleep(600);
      },
    ],
    [
      'merge',
      async (tx, n) => {
        await writerIn.p;
        await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${d}' FOR ${rootMode}`);
        n.balanceEntriesVisibleToEmptinessCheck = await tx.balanceEntry.count({ where: { userId: d } });
        await tx.user.delete({ where: { id: d } });
      },
    ],
  ]);
  r.final = { dropAccountStillExists: !!(await db.user.findUnique({ where: { id: d } })), ledgerRows: await db.balanceEntry.count({ where: { userId: d } }) };
  return r;
}
out.scenarios.S4_noKeyUpdate = await s4('NO KEY UPDATE');
out.scenarios.S4_forUpdate = await s4('UPDATE');

// ---------- S5: SHARE upgrade hazard and SHARE-vs-waiting-writer fairness ----------
{
  const u = await mkUser('s5');
  const both = [gate(), gate()];
  out.scenarios.S5a_share_then_upgrade = await run('S5a two SHARE holders each upgrading to NO KEY UPDATE', [
    ['t1', async (tx) => { await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${u}' FOR SHARE`); both[0].open(); await both[1].p; await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${u}' FOR NO KEY UPDATE`); }],
    ['t2', async (tx) => { await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${u}' FOR SHARE`); both[1].open(); await both[0].p; await sleep(100); await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${u}' FOR NO KEY UPDATE`); }],
  ]);
  const v = await mkUser('s5b');
  const holding = gate(), suspensionQueued = gate();
  out.scenarios.S5b_share_vs_queued_suspension = await run('S5b new SHARE request while suspension is queued behind a SHARE holder', [
    ['shareHolder', async (tx) => { await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${v}' FOR SHARE`); holding.open(); await suspensionQueued.p; await sleep(400); }],
    ['suspension', async (tx) => { await holding.p; setTimeout(() => suspensionQueued.open(), 150); await tx.$executeRawUnsafe(`UPDATE "User" SET suspended = true WHERE id='${v}'`); }],
    ['laterSignin', async (tx, n) => {
      await suspensionQueued.p;
      const t0 = Date.now();
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);
      try { await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id='${v}' FOR SHARE`); n.sharedImmediatelyWhileSuspensionWaits = true; }
      catch (e) { n.sharedImmediatelyWhileSuspensionWaits = false; n.err = fullErr(e).sqlstate; }
      n.elapsedMs = Date.now() - t0;
    }],
  ]);
}

// ---------- S6: advisory key equality between app builder labels and the DB trigger ----------
{
  const addr = `Subj${rnd()}${rnd()}`;
  const holding = gate(), probed = gate();
  const probeRes = {};
  const r = await run('S6 trigger-held key vs application label key', [
    ['triggerInsert', async (tx) => {
      await tx.walletIdentity.create({ data: { address: addr, userId: await mkUser('s6') } });
      holding.open();
      await probed.p;
    }],
    ['appLabelProbe', async (tx) => {
      await holding.p;
      const same = (await tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtextextended('wallet-subject:${addr}', 0)) AS got`))[0].got;
      const other = (await tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtextextended('wallet-subject:${addr}x', 0)) AS got`))[0].got;
      probeRes.appLabelKeyAcquirable = same; // false => identical key held by the trigger
      probeRes.differentLabelAcquirable = other;
      probed.open();
    }],
  ]);
  out.scenarios.S6_key_equality = { ...r, probe: probeRes };
}

await mon.$disconnect();
await db.$disconnect();
console.log(JSON.stringify(out, null, 2));
