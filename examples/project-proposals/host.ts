import assert from 'node:assert/strict';
import {
  createGuildProjectProposalHandlers,
  GuildProjectProposalHttpError,
} from './guild-profiles/project-proposal-http';
import { createHash, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { pool } from './connection';
import {
  retryWholeTransaction,
  CommandReceiptError,
  type CommandReceiptTransaction,
} from './command-receipts';
import { saveGuildDraft, type GuildDraftActor } from './guild-profiles/draft-storage';
import {
  saveGuildProjectProposal,
  readGuildProjectProposal,
  GuildDraftStorageError,
} from './guild-profiles/project-proposal-storage';
const id = 'synthetic-proposal-' + randomUUID();
const actor: GuildDraftActor = {
  accountId: id,
  actorAccountId: id,
  sessionHash: createHash('sha256')
    .update('synthetic-cookie-' + id)
    .digest('hex'),
};
async function transaction<T>(work: (tx: CommandReceiptTransaction) => Promise<T>): Promise<T> {
  return retryWholeTransaction(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const port: CommandReceiptTransaction = {
        dialect: 'POSTGRESQL',
        isolation: 'READ_COMMITTED',
        async query<Row>(sql: string, bindings: readonly (string | null)[]) {
          try {
            return (await client.query<Row>(sql, bindings)).rows;
          } catch (error) {
            const state = (error as { code?: string }).code;
            throw new CommandReceiptError(
              state === '40001' || state === '40P01' ? 'RETRY_TRANSACTION' : 'STORAGE_UNAVAILABLE',
            );
          }
        },
      };
      const result = await work(port);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
try {
  const setup = await pool.connect();
  try {
    await setup.query('INSERT INTO "User"(id) VALUES($1)', [id]);
    await setup.query(
      'INSERT INTO "Session"("tokenHash","userId","expiresAt") VALUES($1,$2,(clock_timestamp() AT TIME ZONE \'UTC\')+interval \'1 hour\')',
      [actor.sessionHash, id],
    );
  } finally {
    setup.release();
  }
  const draft = await transaction((tx) =>
    saveGuildDraft(
      tx,
      {
        actor,
        input: {
          guildDraftId: null,
          expectedRevision: 0,
          profile: {
            name: 'Synthetic existing project',
            slug: 'synthetic-' + randomUUID(),
            description: 'Private preparation only',
          },
        },
        idempotencyKey: 'draft-' + id,
        requestId: 'draft-' + id,
      },
      { allowNewWrites: true },
    ),
  );
  const input = {
    guildDraftId: draft.draft.id,
    expectedDraftRevision: 1,
    expectedProposalRevision: 0,
    candidateToken: {
      chain: 'SOLANA',
      networkIdentity: 'synthetic-genesis',
      kind: 'TOKEN',
      mint: bs58.encode(new Uint8Array(32).fill(17)),
      tokenProgram: bs58.encode(new Uint8Array(32).fill(18)),
    },
    publicEvidenceRefs: ['https://PUBLIC.EXAMPLE'],
  };
  const save = (body: unknown, key: string, allowNewWrites = true) =>
    transaction((tx) =>
      saveGuildProjectProposal(
        tx,
        { actor, input: body, idempotencyKey: key, requestId: 'request-' + key },
        { allowNewWrites },
      ),
    );
  const first = await save(input, 'first-' + id);
  assert.equal(first.proposal.state, 'PENDING_VERIFICATION');
  assert.equal(first.proposal.projectType, 'EXISTING_PROJECT');
  assert.equal(first.proposal.founderControlVerified, false);
  assert.equal(first.proposal.recognizesGuild, false);
  assert.equal(first.proposal.activatesToken, false);
  assert.equal(first.proposal.createsPermissionGrant, false);
  assert.equal(first.proposal.publicProfileApproved, false);
  assert.deepEqual(first.proposal.publicEvidenceRefs, ['https://public.example/']);
  const second = await save(
    {
      ...input,
      expectedProposalRevision: 1,
      publicEvidenceRefs: ['https://public.example/updated'],
    },
    'second-' + id,
  );
  assert.equal(second.proposal.revision, 2);
  assert.deepEqual(
    await transaction((tx) => readGuildProjectProposal(tx, actor, draft.draft.id)),
    second.proposal,
  );
  assert.deepEqual(await save(input, 'first-' + id, false), {
    status: 'REPLAYED',
    proposal: first.proposal,
  });
  await assert.rejects(
    save({ ...input, publicEvidenceRefs: ['https://public.example/changed'] }, 'first-' + id),
    (e) => e instanceof CommandReceiptError && e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await assert.rejects(
    transaction((tx) =>
      readGuildProjectProposal(tx, { ...actor, sessionHash: 'b'.repeat(64) }, draft.draft.id),
    ),
    (e) => e instanceof GuildDraftStorageError && e.code === 'UNAUTHENTICATED',
  );
  let attempts = 0;
  await transaction(async (tx) => {
    const saved = await saveGuildProjectProposal(
      tx,
      {
        actor,
        input: { ...input, expectedProposalRevision: 2 },
        idempotencyKey: 'retry-' + id,
        requestId: 'retry',
      },
      { allowNewWrites: true },
    );
    if (++attempts === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
    return saved;
  });
  assert.equal(attempts, 2);
  const check = await pool.connect();
  try {
    const {
      rows: [row],
    } = await check.query(
      'SELECT (SELECT count(*)::int FROM "GuildProjectProposalVersion" WHERE "ownerAccountId"=$1) AS versions,(SELECT count(*)::int FROM "GuildProjectProposal" WHERE "ownerAccountId"=$1) AS proposals,(SELECT count(*)::int FROM "AuditEvent" WHERE "actorId"=$1) AS audits,(SELECT count(*)::int FROM "OutboxEvent") AS outbox',
      [id],
    );
    assert.deepEqual(row, { versions: 3, proposals: 1, audits: 4, outbox: 0 });
  } finally {
    check.release();
  }
  const http = createGuildProjectProposalHandlers({
    version: 'v1',
    requestId: randomUUID,
    actor: async () => actor,
    checkOrigin(request) {
      if (request.headers.get('origin') !== 'https://synthetic.example')
        throw new GuildProjectProposalHttpError(403);
    },
    rateLimit: async () => {},
    read: async (a, target) => ({
      version: 'v1',
      guildDraftId: target,
      proposal: await transaction((tx) => readGuildProjectProposal(tx, a, target)),
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    }),
    save: async (command) => {
      const result = await transaction((tx) =>
        saveGuildProjectProposal(tx, command, { allowNewWrites: false }),
      );
      return {
        version: 'v1',
        guildDraftId: result.proposal.guildDraftId,
        ...result,
        writesAvailable: false,
        unavailableReason: 'DISABLED',
      };
    },
  });
  const get = await http.GET(new Request('https://synthetic.example'), draft.draft.id);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).proposal.revision, 3);
  assert.equal(get.headers.get('cache-control'), 'private, no-store');
  const post = () =>
    new Request('https://synthetic.example', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://synthetic.example',
        'Idempotency-Key': 'first-' + id,
      },
      body: JSON.stringify({
        expectedDraftRevision: input.expectedDraftRevision,
        expectedProposalRevision: input.expectedProposalRevision,
        candidateToken: input.candidateToken,
        publicEvidenceRefs: input.publicEvidenceRefs,
      }),
    });
  const original = await http.POST(post(), draft.draft.id);
  assert.equal(original.status, 200);
  const ack = await original.json();
  assert.equal(ack.status, 'REPLAYED');
  assert.deepEqual(ack.proposal, first.proposal);
  assert.equal(ack.writesAvailable, false);
  const denied = await http.POST(
    new Request(post(), {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://foreign.example',
        'Idempotency-Key': 'first-' + id,
      },
    }),
    draft.draft.id,
  );
  assert.equal(denied.status, 403);
  console.log(
    JSON.stringify({
      synthetic: true,
      independentPgHost: true,
      portablePrivateHttp: true,
      originalHttpReplayWhenDisabled: true,
      foreignOriginDenied: true,
      exactPendingCandidate: true,
      noFounderGuildTokenGrantPublicEffect: true,
      immutableOriginalReplayWhenDisabled: true,
      currentCookieRequired: true,
      changedKeyDenied: true,
      wholeRetryOnce: true,
      noOutbox: true,
    }),
  );
} finally {
  await pool.end();
}
