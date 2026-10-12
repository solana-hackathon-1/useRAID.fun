import { describe, it, expect } from 'vitest';
import { ADMIN_PAGE, adminListArgs, adminPageNumber } from '../src/lib/admin-lists';

describe('admin list queries', () => {
  it('normalizes page numbers', () => {
    expect(adminPageNumber(undefined)).toBe(1);
    expect(adminPageNumber('0')).toBe(1);
    expect(adminPageNumber('-3')).toBe(1);
    expect(adminPageNumber('abc')).toBe(1);
    expect(adminPageNumber('2.9')).toBe(2);
    expect(adminPageNumber('3')).toBe(3);
  });
  it('pages with one extra row to detect a next page', () => {
    const args = adminListArgs({ creatorPage: '3', campaignPage: '2' }, ['admin-x']);
    expect(args.users.skip).toBe(2 * ADMIN_PAGE);
    expect(args.users.take).toBe(ADMIN_PAGE + 1);
    expect(args.raids.skip).toBe(ADMIN_PAGE);
    expect(args.posts.skip).toBe(0);
    expect(args.users.orderBy).toEqual([{ createdAt: 'desc' }]);
  });
  it('always excludes allowlisted administrators, keeping users without an X id', () => {
    const { users } = adminListArgs({}, ['admin-x']);
    expect(users.where.AND[0]).toEqual({ OR: [{ xId: null }, { xId: { notIn: ['admin-x'] } }] });
  });
  it('searches case-insensitively across each list', () => {
    const args = adminListArgs({ q: '  Bonk  ' }, []);
    expect(args.q).toBe('Bonk');
    const ci = { contains: 'Bonk', mode: 'insensitive' };
    expect(args.users.where.AND[1]).toEqual({ handle: ci });
    expect(args.raids.where).toEqual({
      OR: [{ id: 'Bonk' }, { title: ci }, { creator: { handle: ci } }],
    });
    expect(args.posts.where).toEqual({ OR: [{ id: 'Bonk' }, { raidId: 'Bonk' }, { text: ci }] });
  });
  it('lists creators newest first with no approval filter or ordering', () => {
    const { users } = adminListArgs({}, []);
    expect(users.orderBy).toEqual([{ createdAt: 'desc' }]);
    expect(JSON.stringify(users.where)).not.toContain('approved');
  });
});
