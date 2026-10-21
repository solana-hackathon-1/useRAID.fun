// Claude independent design review probes. Disposable DB only. Read-only against repo.
import { createRequire } from 'node:module';
const require = createRequire('/Users/dushyant/Documents/useRAID.fun/package.json');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
const out = {};
const mk = async (tag) => {
  const u = await db.user.create({ data: { handle: `p_${tag}_${Math.random().toString(36).slice(2, 7)}` } });
  return u.id;
};
const sess = (userId, n = Math.random().toString(36).slice(2)) => ({
  tokenHash: `t_${n}`,
  userId,
  expiresAt: new Date(Date.now() + 3600e3),
});
const code = (e) => (e?.meta?.code ?? e?.code ?? '') + ' ' + String(e?.message ?? e).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160);
const settle = (p) => p.then(() => 'ok', (e) => 'ERR ' + code(e));

// X1: session writer without root (DELETE own Session, INSERT Session) vs merge-style root + Session sweep.
async function x1(mode) {
  const d = await mk('d');
  await db.session.create({ data: sess(d, 'old_' + mode + Math.random()) });
  const old = (await db.session.findFirst({ where: { userId: d } })).tokenHash;
  const deleted = gate(), rooted = gate();
  const signin = settle(db.$transaction(async (tx) => {
    await tx.$queryRaw`DELETE FROM "Session" WHERE "tokenHash" = ${old} RETURNING "userId"`;
    deleted.open();
    await rooted.p;
    await sleep(150);
    await tx.session.create({ data: sess(d) }); // FK -> KEY SHARE on User(d)
  }));
  const merge = settle(db.$transaction(async (tx) => {
    await deleted.p;
    if (mode === 'FOR UPDATE') await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${d} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${d} FOR NO KEY UPDATE`;
    rooted.open();
    await tx.session.deleteMany({ where: { userId: d } }); // waits on the row signin deleted
    await tx.user.delete({ where: { id: d } });
  }));
  return { signin: await signin, merge: await merge };
}
out.X1_root_less_session_writer_vs_merge = {
  baseline_NO_KEY_UPDATE: await x1('FOR NO KEY UPDATE'),
  amended_FOR_UPDATE: await x1('FOR UPDATE'),
};

// X2: any tx inserting FK rows for two users in non-sorted order vs two sorted roots.
async function x2b(mode) {
  const a = await mk('a'), b = await mk('b');
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const first = gate(), second = gate();
  const multi = settle(db.$transaction(async (tx) => {
    await tx.session.create({ data: sess(hi) });
    first.open();
    await second.p;
    await sleep(150);
    await tx.session.create({ data: sess(lo) });
  }));
  const roots = settle(db.$transaction(async (tx) => {
    await first.p;
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = '${lo}' FOR ${mode}`);
    second.open();
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = '${hi}' FOR ${mode}`);
  }));
  return { multiUserFkWriter: await multi, sortedRoots: await roots };
}
out.X2_multi_user_FK_writer_vs_sorted_roots = {
  FOR_NO_KEY_UPDATE: await x2b('NO KEY UPDATE'),
  FOR_UPDATE: await x2b('UPDATE'),
};

// X3 (independent LP03 check): xId UPDATE needs FOR UPDATE strength.
{
  const u = await mk('x');
  const ks = gate(), done = gate();
  const holder = settle(db.$transaction(async (tx) => {
    await tx.session.create({ data: sess(u) }); // KEY SHARE on User(u)
    ks.open();
    await done.p;
  }));
  await ks.p;
  const probe = settle(db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '600ms'`);
    await tx.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = '${u}' FOR NO KEY UPDATE`);
    const nonKey = await settle(tx.$executeRawUnsafe(`UPDATE "User" SET "handle" = 'renamed_${u.slice(-4)}' WHERE id = '${u}'`));
    const key = await settle(tx.$executeRawUnsafe(`UPDATE "User" SET "xId" = '99${Date.now()}' WHERE id = '${u}'`));
    out.X3_xId_update_under_NO_KEY_UPDATE_with_KEY_SHARE_holder = { nonKeyUpdate: nonKey, xIdUpdate: key };
  }));
  await probe;
  done.open();
  await holder;
}

// X4: linked-wallet exclusivity trigger takes the subject advisory key at INSERT/UPDATE OF address, not on UPDATE userId.
{
  const u1 = await mk('w1'), u2 = await mk('w2');
  const addr = 'SubjAddr' + Math.random().toString(36).slice(2, 8);
  await db.walletIdentity.create({ data: { address: addr, userId: u1 } });
  const t = settle(db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`);
    await tx.walletIdentity.updateMany({ where: { userId: u1 }, data: { userId: u2 } }); // merge-style move
    const rows = await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`);
    out.X4_merge_style_wallet_move_advisory_locks_held = rows[0].n;
  }));
  await t;
}
console.log(JSON.stringify(out, null, 2));
await db.$disconnect();
