import { describe, expect, it } from 'vitest';
import { evaluate, type AllowlistEntry, type AuditReport } from '../scripts/audit-check';

const report: AuditReport = {
  vulnerabilities: {
    'left-pad': {
      severity: 'moderate',
      via: [
        {
          source: 1,
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'moderate',
        },
      ],
    },
    parent: { severity: 'moderate', via: ['left-pad'] },
    tiny: {
      severity: 'low',
      via: [{ source: 2, url: 'https://github.com/advisories/GHSA-low-low-low', severity: 'low' }],
    },
  },
};
const entry: AllowlistEntry = {
  package: 'left-pad',
  advisory: 'GHSA-aaaa-bbbb-cccc',
  reason: 'test',
  expires: '2027-01-01',
};
const now = new Date('2026-10-02T00:00:00Z');

describe('audit-check evaluate', () => {
  it('fails on an unlisted moderate advisory and ignores low ones', () => {
    expect(evaluate(report, [], now)).toEqual([
      expect.objectContaining({ package: 'left-pad', advisory: 'GHSA-aaaa-bbbb-cccc' }),
    ]);
  });

  it('passes when the advisory is allowlisted', () => {
    expect(evaluate(report, [entry], now)).toEqual([]);
  });

  it('fails when the allowlist entry has expired', () => {
    const failures = evaluate(report, [{ ...entry, expires: '2026-09-01' }], now);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/expired/);
  });
});
