import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECKED_STATES } from '@/lib/states';

const sql = ['202610020011_ledger_integrity', '202610020012_state_checks']
  .map((name) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'))
  .join('\n');

function checks() {
  const found = new Map<string, string[]>();
  for (const m of sql.matchAll(/ADD CONSTRAINT "(\w+_check)" CHECK \("\w+" IN \(([^)]*)\)\)/g))
    found.set(
      m[1],
      [...m[2].matchAll(/'([A-Z_]+)'/g)].map((v) => v[1]),
    );
  return found;
}

describe('state vocabularies', () => {
  it('match every CHECK constraint in the migrations, in both directions', () => {
    const found = checks();
    expect([...found.keys()].sort()).toEqual(Object.keys(CHECKED_STATES).sort());
    for (const [name, values] of found)
      expect(values, name).toEqual([...CHECKED_STATES[name as keyof typeof CHECKED_STATES]]);
  });
  it('keeps the post-state checks NOT VALID until a post-audit migration validates them', () => {
    for (const name of Object.keys(CHECKED_STATES).filter((n) => /^(Raid|Post)_/.test(n)))
      expect(sql).toMatch(new RegExp(`"${name}" CHECK \\([^;]*\\) NOT VALID;`));
  });
  it('lists no duplicate values', () => {
    for (const [name, values] of Object.entries(CHECKED_STATES))
      expect(new Set(values).size, name).toBe(values.length);
  });
});
