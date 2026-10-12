import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/db', () => ({ db: {} }));
import { HttpError } from '../src/lib/auth-primitives';
import { assertCreatorAccess } from '../src/lib/campaigns';

// DEC-2026-10-12-01: creating a Raid is self-serve; only a suspension blocks it.
describe('creator access', () => {
  it('lets a signed-in user create Raids without administrator approval', () => {
    for (const approved of [false, true]) {
      const user = { approved, suspended: false };
      expect(() => assertCreatorAccess(user)).not.toThrow();
    }
  });
  it('still blocks suspended users', () => {
    for (const approved of [true, false]) {
      try {
        const user = { approved, suspended: true };
        assertCreatorAccess(user);
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).status).toBe(403);
      }
    }
  });
});
