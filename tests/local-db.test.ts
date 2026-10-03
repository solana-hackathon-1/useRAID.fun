import { describe, expect, it } from 'vitest';
import { checkLocalUrl } from '../scripts/local-db';

describe('checkLocalUrl', () => {
  it('accepts a local database with the expected name', () => {
    expect(
      checkLocalUrl('postgresql://useraid:useraid@localhost:5432/useraid_dev', 'useraid_dev')
        .pathname,
    ).toBe('/useraid_dev');
    expect(() =>
      checkLocalUrl('postgresql://useraid:useraid@127.0.0.1:5432/useraid_dev', 'useraid_dev'),
    ).not.toThrow();
  });
  it('rejects remote hosts, other databases and bad URLs', () => {
    expect(() =>
      checkLocalUrl('postgresql://u:p@db.example.com:5432/useraid_dev', 'useraid_dev'),
    ).toThrow(/local PostgreSQL/);
    expect(() => checkLocalUrl('postgresql://u:p@localhost:5432/useraid', 'useraid_dev')).toThrow(
      /useraid_dev/,
    );
    expect(() => checkLocalUrl(undefined, 'useraid_dev')).toThrow();
    expect(() => checkLocalUrl('not a url', 'useraid_dev')).toThrow();
  });
});
