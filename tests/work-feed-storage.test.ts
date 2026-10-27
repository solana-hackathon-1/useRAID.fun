import { describe, expect, it } from 'vitest';
import { readWorkDetail } from '../src/work-loop/feed-storage';
import { canonicalRequestDigest } from '../src/command-receipts';
import { raidTerms } from './helpers/raid-terms-fixture';

const listingId = '11111111-1111-4111-8111-111111111111';
/** A port whose second read disagrees with the first: the last open slot is taken in between (READ COMMITTED). */
const racingPort = (openSlots: { id: string }[], digest = canonicalRequestDigest(raidTerms())) =>
  ({
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    query: async (sql: string) =>
      sql.includes('FROM "RaidSlot" WHERE')
        ? openSlots
        : [
            {
              listingId,
              guildId: 'synthetic-guild',
              termsVersionId: '22222222-2222-4222-8222-222222222222',
              snapshot: raidTerms(),
              digest,
              createdMicros: '1',
              availableSlots: 1,
            },
          ],
  }) as never;
describe('public brief under a concurrent fill', () => {
  it('answers not found, never a contract error, when the last open slot disappears between the two reads', async () => {
    await expect(readWorkDetail(racingPort([]), listingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('still returns the brief while a slot is open', async () => {
    const brief = await readWorkDetail(
      racingPort([{ id: '33333333-3333-4333-8333-333333333333' }]),
      listingId,
    );
    expect(brief.openSlotIds).toEqual(['33333333-3333-4333-8333-333333333333']);
  });
  it('exposes the stored terms digest a person consents to', async () => {
    const brief = await readWorkDetail(
      racingPort([{ id: '33333333-3333-4333-8333-333333333333' }]),
      listingId,
    );
    expect(brief.termsDigest).toBe(canonicalRequestDigest(raidTerms()));
  });
  it('hides a brief whose stored digest does not match its terms, so nobody consents to a digest that cannot be verified', async () => {
    await expect(
      readWorkDetail(
        racingPort([{ id: '33333333-3333-4333-8333-333333333333' }], 'f'.repeat(64)),
        listingId,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
