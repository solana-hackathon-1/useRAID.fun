import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CommandReceiptTransaction } from '../src/command-receipts';
import { lockOfferForAcceptance } from '../src/work-loop/admission-acceptance';

const offerRow = (offeredByAccountId: unknown) => ({
  id: randomUUID(),
  applicationId: randomUUID(),
  slotId: randomUUID(),
  termsVersionId: randomUUID(),
  participantId: randomUUID(),
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  state: 'PENDING',
  acceptedEngagementId: null,
  offeredByAccountId,
});
const txReturning = (row: Record<string, unknown>) =>
  ({ query: async () => [row] }) as unknown as CommandReceiptTransaction;

describe('locked offer issuer', () => {
  it('returns the issuing account verbatim', async () => {
    const locked = await lockOfferForAcceptance(txReturning(offerRow('founder-1')), randomUUID());
    expect(locked.issuer).toBe('founder-1');
  });
  it.each([null, undefined, '', 7])(
    'fails the storage contract for an unusable issuer column (%s)',
    async (issuer) => {
      await expect(
        lockOfferForAcceptance(txReturning(offerRow(issuer)), randomUUID()),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
    },
  );
});
