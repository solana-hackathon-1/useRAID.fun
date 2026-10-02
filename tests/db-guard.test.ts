import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

afterEach(() => vi.unstubAllEnvs());

describe('assertTestDatabase', () => {
  const url = (host: string, name = 'useraid_test') => `postgresql://u:p@${host}:5432/${name}`;
  it('accepts the test database on a local host', () => {
    expect(() => assertTestDatabase('useraid_test', url('localhost'))).not.toThrow();
    expect(() => assertTestDatabase('useraid_test', url('127.0.0.1'))).not.toThrow();
  });
  it('rejects a remote host even with the right name', () => {
    expect(() => assertTestDatabase('useraid_test', url('db.prod.example.com'))).toThrow(/remote/);
  });
  it('rejects the wrong name or a missing URL', () => {
    expect(() => assertTestDatabase('useraid_test', url('localhost', 'useraid'))).toThrow();
    expect(() => assertTestDatabase('useraid_dev', url('localhost'))).toThrow();
    expect(() => assertTestDatabase('useraid_test', '')).toThrow();
  });
  it('allows a remote host only with ALLOW_REMOTE_TEST_DB=true', () => {
    vi.stubEnv('ALLOW_REMOTE_TEST_DB', 'true');
    expect(() => assertTestDatabase('useraid_test', url('db.prod.example.com'))).not.toThrow();
  });
  it('refuses everything in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertTestDatabase('useraid_test', url('localhost'))).toThrow(/production/);
  });
});

describe('truncateAll', () => {
  it('truncates only the non-empty public tables, never _prisma_migrations', async () => {
    const executed: string[] = [];
    await truncateAll({
      $queryRawUnsafe: async (query: string) => {
        if (query.includes('pg_tables')) {
          expect(query).toContain('_prisma_migrations');
          return [{ tablename: 'User' }, { tablename: 'Job' }];
        }
        expect(query).toContain('EXISTS (SELECT 1 FROM "Job")');
        return [{ tablename: 'Job' }];
      },
      $executeRawUnsafe: async (query: string) => void executed.push(query),
    });
    expect(executed).toEqual(['TRUNCATE "Job" CASCADE']);
  });
});
