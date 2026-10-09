import { describe, expect, it } from 'vitest';
import {
  CommandReceiptError,
  canonicalRequestDigest,
  executeIdempotentCommand,
  processInboundDelivery,
  retryWholeTransaction,
  type CommandOutcome,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../src/command-receipts';
import {
  classifyCommandReceiptFailure,
  createPrismaCommandTransaction,
} from '../src/lib/command-receipts-adapter';

type Call = { sql: string; bindings: readonly SqlBinding[] };
function scripted(respond: (sql: string, bindings: readonly SqlBinding[]) => unknown[]) {
  const calls: Call[] = [];
  const port: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    query: async <Row>(sql: string, bindings: readonly SqlBinding[]) => {
      calls.push({ sql, bindings });
      return respond(sql, bindings) as Row[];
    },
  };
  return { port, calls };
}
const command = {
  actorId: 'account-1',
  commandKind: 'CommitEngagement',
  idempotencyKey: 'key-1',
  requestId: 'request-1',
  request: { slot: 'slot-1', expectedTermsVersion: 'terms-v1', note: 'SECRET-PRIVATE-BRIEF' },
};
const event = {
  type: 'work.engagement_committed.v1',
  aggregateId: 'engagement-1',
  aggregateVersion: 1,
  guildId: 'guild-1',
  payload: { termsVersionId: 'terms-v1' },
};
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'RESOLVED',
    (e: unknown) => (e instanceof CommandReceiptError ? e.code : `OTHER:${String(e)}`),
  );
const never = async (): Promise<CommandOutcome> => {
  throw Error('handler must not run');
};
const isInsert = (table: string) => (call: Call) => call.sql.includes(`INSERT INTO "${table}"`);

describe('canonical request digest', () => {
  it('is a stable lowercase SHA-256 independent of key order and sensitive to every value', () => {
    const a = canonicalRequestDigest({ b: 1, a: { y: [1, 2], x: 'v' } });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalRequestDigest({ a: { x: 'v', y: [1, 2] }, b: 1 })).toBe(a);
    expect(canonicalRequestDigest({ b: 1, a: { y: [2, 1], x: 'v' } })).not.toBe(a);
    expect(canonicalRequestDigest({ b: '1', a: { y: [1, 2], x: 'v' } })).not.toBe(a);
    expect(canonicalRequestDigest({ b: 1, a: { y: [1, 2], x: 'w' } })).not.toBe(a);
    expect(canonicalRequestDigest(null)).not.toBe(canonicalRequestDigest('null'));
  });

  it('rejects values whose identity is ambiguous or not JSON', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const bad of [
      { a: undefined },
      [undefined],
      { a: 10n },
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: new Date(0) },
      { a: () => 1 },
      { a: new Map() },
      { a: 2 ** 60 },
      cycle,
      { a: 'x'.repeat(70_000) },
      undefined,
    ])
      expect(() => canonicalRequestDigest(bad)).toThrow(CommandReceiptError);
  });
});

describe('input validation happens before any SQL', () => {
  it.each([
    ['actor', { actorId: '' }],
    ['actor charset', { actorId: 'a b' }],
    ['kind lowercase', { commandKind: 'commitEngagement' }],
    ['kind too short', { commandKind: 'Ab' }],
    ['key space', { idempotencyKey: 'k k' }],
    ['key empty', { idempotencyKey: '' }],
    ['request id', { requestId: '' }],
    ['request undefined', { request: undefined }],
  ])('rejects invalid %s', async (_name, patch) => {
    const { port, calls } = scripted(() => []);
    expect(await code(executeIdempotentCommand(port, { ...command, ...patch }, never))).toBe(
      'INVALID_INPUT',
    );
    expect(calls).toHaveLength(0);
  });

  it('fails closed for a port that is not PostgreSQL READ COMMITTED', async () => {
    for (const port of [
      { dialect: 'MYSQL', isolation: 'READ_COMMITTED', query: async () => [] },
      { dialect: 'POSTGRESQL', isolation: 'SERIALIZABLE', query: async () => [] },
      { dialect: 'POSTGRESQL', isolation: 'READ_COMMITTED' },
    ])
      expect(
        await code(
          executeIdempotentCommand(port as unknown as CommandReceiptTransaction, command, never),
        ),
      ).toBe('STORAGE_CONTRACT');
  });
});

describe('replay and conflict', () => {
  const digest = () => canonicalRequestDigest(command.request);
  it('returns the stored result without running the handler or writing', async () => {
    const { port, calls } = scripted((sql) =>
      sql.includes('INSERT INTO "CommandReceipt"')
        ? []
        : [{ id: 'receipt-0', requestDigest: digest(), resultRef: 'engagement-0' }],
    );
    expect(await executeIdempotentCommand(port, command, never)).toEqual({
      status: 'REPLAYED',
      receiptId: 'receipt-0',
      resultRef: 'engagement-0',
    });
    expect(calls.filter(isInsert('AuditEvent'))).toHaveLength(0);
    expect(calls.filter((c) => c.sql.includes('UPDATE'))).toHaveLength(0);
  });

  it('conflicts on a different digest and performs no write after the lookup', async () => {
    const { port, calls } = scripted((sql) =>
      sql.includes('INSERT INTO "CommandReceipt"')
        ? []
        : [{ id: 'receipt-0', requestDigest: 'f'.repeat(64), resultRef: 'engagement-0' }],
    );
    expect(await code(executeIdempotentCommand(port, command, never))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(calls).toHaveLength(2);
  });

  it('refuses a receipt row that has no result or a malformed shape', async () => {
    for (const row of [
      { id: 'receipt-0', requestDigest: digest(), resultRef: null },
      { id: 'receipt-0', requestDigest: 5, resultRef: 'x' },
    ]) {
      const { port } = scripted((sql) =>
        sql.includes('INSERT INTO "CommandReceipt"') ? [] : [row],
      );
      expect(await code(executeIdempotentCommand(port, command, never))).toBe('STORAGE_CONTRACT');
    }
    const { port } = scripted(() => []);
    expect(await code(executeIdempotentCommand(port, command, never))).toBe('STORAGE_CONTRACT');
  });
});

describe('first execution', () => {
  const run = (events: CommandOutcome['events'] = [event], resultRef = 'engagement-1') => {
    const harness = scripted((sql) =>
      sql.includes('INSERT INTO "CommandReceipt"') || sql.includes('INSERT INTO "AuditEvent"')
        ? [{ id: 'row-1' }]
        : sql.includes('UPDATE')
          ? [{ id: 'row-1' }]
          : [],
    );
    const seen: string[] = [];
    const result = executeIdempotentCommand(harness.port, command, async (context) => {
      seen.push(context.receiptId);
      return { resultRef, events };
    });
    return { ...harness, result, seen };
  };

  it('claims the receipt first, then writes audit, outbox and finalizes the result last', async () => {
    const { result, calls, seen } = run();
    expect(await result).toEqual({
      status: 'EXECUTED',
      receiptId: 'row-1',
      resultRef: 'engagement-1',
    });
    expect(seen).toEqual(['row-1']);
    const order = calls.map((c) =>
      c.sql.includes('"CommandReceipt"') && c.sql.includes('INSERT')
        ? 'receipt'
        : c.sql.includes('"AuditEvent"')
          ? 'audit'
          : c.sql.includes('"OutboxEvent"')
            ? 'outbox'
            : c.sql.includes('UPDATE "CommandReceipt"')
              ? 'finalize'
              : 'other',
    );
    expect(order).toEqual(['receipt', 'audit', 'outbox', 'finalize']);
  });

  it('skips the outbox for a non-publishing event and stores only digests, never the request', async () => {
    const { result, calls } = run([{ ...event, publish: false }]);
    await result;
    expect(calls.filter(isInsert('OutboxEvent'))).toHaveLength(0);
    expect(JSON.stringify(calls)).not.toContain('SECRET-PRIVATE-BRIEF');
    const receiptCall = calls.find(isInsert('CommandReceipt'));
    expect(receiptCall?.bindings).toContain(canonicalRequestDigest(command.request));
  });

  it.each([
    ['no events', []],
    ['unknown family', [{ ...event, type: 'secret.thing_happened.v1' }]],
    ['free-text payload field', [{ ...event, payload: { note: 'SECRET' } }]],
    ['zero version', [{ ...event, aggregateVersion: 0 }]],
    ['too many events', Array.from({ length: 21 }, () => event)],
  ])('rejects %s after the callback and never finalizes', async (_name, events) => {
    const { result, calls } = run(events as CommandOutcome['events']);
    expect(await code(result)).toBe('INVALID_INPUT');
    expect(calls.filter((c) => c.sql.includes('UPDATE'))).toHaveLength(0);
  });

  it('rejects an invalid result reference', async () => {
    const { result } = run([event], 'has space');
    expect(await code(result)).toBe('INVALID_INPUT');
  });

  it('passes the callback error through untouched and writes nothing further', async () => {
    const failure = new Error('domain: slot filled');
    const { port, calls } = scripted(() => [{ id: 'row-1' }]);
    await expect(
      executeIdempotentCommand(port, command, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it('sanitizes driver failures and rejects non-array results', async () => {
    const failing: CommandReceiptTransaction = {
      dialect: 'POSTGRESQL',
      isolation: 'READ_COMMITTED',
      query: async () => {
        throw Error('private driver detail postgres://secret');
      },
    };
    const error = await executeIdempotentCommand(failing, command, never).catch((e) => e);
    expect(error).toBeInstanceOf(CommandReceiptError);
    expect(error.code).toBe('STORAGE_UNAVAILABLE');
    expect(error.message).toBe('STORAGE_UNAVAILABLE');
    const bad = { ...failing, query: async () => 'rows' as never };
    expect(await code(executeIdempotentCommand(bad, command, never))).toBe('STORAGE_CONTRACT');
  });
});

describe('inbound deliveries', () => {
  const delivery = {
    provider: 'helius',
    verifiedDeliveryId: 'delivery-1',
    payload: { claim: 'claim-1', secret: 'SECRET-WEBHOOK-BODY' },
  };
  it.each([
    ['provider uppercase', { provider: 'Helius' }],
    ['provider empty', { provider: '' }],
    ['delivery id space', { verifiedDeliveryId: 'a b' }],
    ['delivery id too long', { verifiedDeliveryId: 'a'.repeat(121) }],
    ['payload undefined', { payload: undefined }],
  ])('rejects %s before SQL', async (_name, patch) => {
    const { port, calls } = scripted(() => []);
    expect(await code(processInboundDelivery(port, { ...delivery, ...patch }, never))).toBe(
      'INVALID_INPUT',
    );
    expect(calls).toHaveLength(0);
  });

  it('treats a repeated delivery as a duplicate without running the handler', async () => {
    const digest = canonicalRequestDigest(delivery.payload);
    const { port } = scripted((sql) =>
      sql.includes('INSERT INTO "InboxDelivery"')
        ? []
        : [{ id: 'inbox-0', payloadDigest: digest, resultRef: 'claim-1' }],
    );
    expect(await processInboundDelivery(port, delivery, never)).toEqual({
      status: 'DUPLICATE',
      deliveryRecordId: 'inbox-0',
      resultRef: 'claim-1',
    });
  });

  it('reports a changed payload under the same delivery id as a conflict', async () => {
    const { port } = scripted((sql) =>
      sql.includes('INSERT INTO "InboxDelivery"')
        ? []
        : [{ id: 'inbox-0', payloadDigest: 'a'.repeat(64), resultRef: 'claim-1' }],
    );
    expect(await code(processInboundDelivery(port, delivery, never))).toBe(
      'DELIVERY_PAYLOAD_CONFLICT',
    );
  });

  it('processes a first delivery and never persists the raw payload', async () => {
    const { port, calls } = scripted(() => [{ id: 'inbox-1' }]);
    const result = await processInboundDelivery(port, delivery, async () => ({
      resultRef: 'claim-1',
      events: [{ ...event, type: 'treasury.claim_paid.v1', payload: { claimId: 'claim-1' } }],
    }));
    expect(result).toEqual({
      status: 'PROCESSED',
      deliveryRecordId: 'inbox-1',
      resultRef: 'claim-1',
    });
    expect(JSON.stringify(calls)).not.toContain('SECRET-WEBHOOK-BODY');
    const audit = calls.find(isInsert('AuditEvent'));
    expect(audit?.bindings).toContain('provider:helius');
    expect(audit?.bindings).toContain('delivery:helius:delivery-1');
  });
});

describe('whole-transaction retry', () => {
  const retryable = new CommandReceiptError('RETRY_TRANSACTION');
  it('re-runs the whole attempt with an attempt counter until success', async () => {
    const seen: number[] = [];
    const value = await retryWholeTransaction(async (n) => {
      seen.push(n);
      if (n < 3) throw retryable;
      return 'done';
    });
    expect(value).toBe('done');
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops at the bound and rethrows the last retryable failure', async () => {
    let runs = 0;
    const error = await retryWholeTransaction(
      async () => {
        runs++;
        throw retryable;
      },
      { maxAttempts: 2 },
    ).catch((e) => e);
    expect(runs).toBe(2);
    expect(error).toBe(retryable);
  });

  it('does not retry other errors, including idempotency conflicts', async () => {
    for (const failure of [new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'), new Error('x')]) {
      let runs = 0;
      await expect(
        retryWholeTransaction(async () => {
          runs++;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(runs).toBe(1);
    }
  });

  it('accepts a host classifier and validates the bound', async () => {
    let runs = 0;
    const value = await retryWholeTransaction(
      async () => {
        if (++runs < 2) throw Object.assign(Error('raw'), { code: '40P01' });
        return 'ok';
      },
      { isRetryable: (e) => (e as { code?: string }).code === '40P01' },
    );
    expect(value).toBe('ok');
    for (const maxAttempts of [0, 11, 1.5])
      expect(await code(retryWholeTransaction(async () => 1, { maxAttempts }))).toBe(
        'INVALID_INPUT',
      );
  });
});

describe('Prisma host adapter', () => {
  it.each([
    [{ code: '40001' }, 'RETRY_TRANSACTION'],
    [{ code: '40P01' }, 'RETRY_TRANSACTION'],
    [{ code: 'P2034' }, 'RETRY_TRANSACTION'],
    [{ code: 'P2010', meta: { code: '40001' } }, 'RETRY_TRANSACTION'],
    [{ code: 'P2010', meta: { code: '23505' } }, 'STORAGE_UNAVAILABLE'],
    [{ code: 'ECONNRESET' }, 'STORAGE_UNAVAILABLE'],
    [new Error('private message'), 'STORAGE_UNAVAILABLE'],
    [null, 'STORAGE_UNAVAILABLE'],
  ])('classifies %j as %s', (error, expected) => {
    expect(classifyCommandReceiptFailure(error).code).toBe(expected);
  });

  it('keeps typed module errors unchanged', () => {
    const typed = new CommandReceiptError('IDEMPOTENCY_KEY_REUSED');
    expect(classifyCommandReceiptFailure(typed)).toBe(typed);
  });

  it('verifies the real isolation once and refuses anything but read committed', async () => {
    const statements: string[] = [];
    const make = (isolation: string) =>
      createPrismaCommandTransaction({
        $queryRawUnsafe: async (sql: string) => {
          statements.push(sql);
          return sql.startsWith('SHOW') ? [{ transaction_isolation: isolation }] : [{ id: 'x' }];
        },
      } as never);
    const good = make('read committed');
    await good.query('SELECT 1', []);
    await good.query('SELECT 2', []);
    expect(statements.filter((s) => s.startsWith('SHOW'))).toHaveLength(1);
    const weak = make('serializable');
    await expect(weak.query('SELECT 1', [])).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  });
});
