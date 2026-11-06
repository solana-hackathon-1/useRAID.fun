import { describe, expect, it } from 'vitest';
import { source } from '../src/work-loop/engagement-authority';

const slotId = '00000000-0000-4000-8000-000000000001';
function recordingTx() {
  const sql: string[] = [];
  const tx = {
    query: async (text: string) => {
      sql.push(text);
      return [{ listingId: '00000000-0000-4000-8000-000000000002' }];
    },
  };
  return { tx, sql };
}
const locks = (sql: string[]) => sql.flatMap((text) => text.match(/FOR [A-Za-z ;'"-]+$/) ?? []);

describe('source lock mode', () => {
  it('locks listing then slot FOR UPDATE by default and FOR SHARE on request', async () => {
    const plain = recordingTx();
    await source(plain.tx as never, slotId);
    expect(locks(plain.sql)).toEqual(['FOR UPDATE', 'FOR UPDATE']);
    const shared = recordingTx();
    await source(shared.tx as never, slotId, 'SHARE');
    expect(locks(shared.sql)).toEqual(['FOR SHARE', 'FOR SHARE']);
  });

  it('cannot carry anything but a known lock mode into the SQL text', async () => {
    const hostile = recordingTx();
    await source(hostile.tx as never, slotId, 'UPDATE; DROP TABLE "RaidSlot"' as never);
    expect(locks(hostile.sql)).toEqual(['FOR UPDATE', 'FOR UPDATE']);
  });
});
