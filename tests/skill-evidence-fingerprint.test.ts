import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_FINGERPRINT_VERSION,
  fingerprintEvidenceReference,
  normalizeEvidenceReference,
} from '../src/skills/evidence-fingerprint';

const same = (a: string, b: string) =>
  expect(fingerprintEvidenceReference(a)).toBe(fingerprintEvidenceReference(b));
const different = (a: string, b: string) =>
  expect(fingerprintEvidenceReference(a)).not.toBe(fingerprintEvidenceReference(b));

describe('T014 evidence reference fingerprint (07.5 duplicate/portfolio reuse signal)', () => {
  it('is a stable lowercase SHA-256 hex digest', () => {
    expect(fingerprintEvidenceReference('https://public.example/portfolio')).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(EVIDENCE_FINGERPRINT_VERSION).toBe('v1');
  });
  it('ignores cosmetic differences: host case, www, fragment, trailing slash, default port', () => {
    same('https://Public.Example/portfolio', 'https://public.example/portfolio/');
    same('https://www.public.example/portfolio', 'https://public.example/portfolio');
    same('https://public.example/portfolio#projects', 'https://public.example/portfolio');
    same('https://public.example:443/portfolio', 'https://public.example/portfolio');
  });
  it('ignores tracking parameters and query order but keeps meaningful parameters', () => {
    same(
      'https://public.example/p?utm_source=x&b=2&a=1&fbclid=abc',
      'https://public.example/p?a=1&b=2',
    );
    different('https://public.example/p?id=1', 'https://public.example/p?id=2');
  });
  it('keeps path case and different resources distinct (no over-matching)', () => {
    different('https://public.example/Alice', 'https://public.example/alice');
    different('https://public.example/a', 'https://public.example/b');
    different('https://public.example/a', 'https://other.example/a');
    different('https://github.com/alice', 'https://github.com/alice/repo');
  });
  it('normalizes to a readable canonical string used for the digest', () => {
    expect(
      normalizeEvidenceReference('https://WWW.Public.Example:443/a/?b=2&utm_medium=m&a=1#x'),
    ).toBe('https://public.example/a?a=1&b=2');
    expect(normalizeEvidenceReference('https://public.example/')).toBe('https://public.example/');
  });
});
