import { describe, expect, it } from 'vitest';
import { CommandReceiptError } from '../src/command-receipts';
import { runSnapshotReadTransaction } from '../src/lib/command-receipts-adapter';

/** #361-5 fix pass: an expired or unobtainable snapshot transaction is the module's sanitized unavailable error. */
describe('snapshot read transaction failures', () => {
  const failing = (code: string) =>
    ({
      $transaction: async () => {
        throw Object.assign(new Error('Transaction API error'), { code });
      },
    }) as never;
  it.each(['P2028', 'P2024'])(
    'maps Prisma %s to STORAGE_UNAVAILABLE, never the raw error',
    async (code) => {
      const error = await runSnapshotReadTransaction(failing(code), async () => 1).catch((e) => e);
      expect(error).toBeInstanceOf(CommandReceiptError);
      expect(error.code).toBe('STORAGE_UNAVAILABLE');
    },
  );
  it('retries a serialization failure and passes domain errors through unchanged', async () => {
    let calls = 0;
    const retrying = {
      $transaction: async () => {
        if (++calls === 1) throw Object.assign(new Error('x'), { code: '40001' });
        return 'ok';
      },
    } as never;
    await expect(runSnapshotReadTransaction(retrying, async () => 1)).resolves.toBe('ok');
    const domain = new Error('domain');
    await expect(
      runSnapshotReadTransaction(
        {
          $transaction: async () => {
            throw domain;
          },
        } as never,
        async () => 1,
      ),
    ).rejects.toBe(domain);
  });
});
