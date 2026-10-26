import { afterEach, expect, it } from 'vitest';
import { workEntryLinks } from '../src/lib/work-entry-links';

const FLAGS = [
  'WORK_WORKSPACE_READS_ENABLED',
  'WORK_CREATION_READS_ENABLED',
  'NOTIFICATIONS_READS_ENABLED',
];
afterEach(() => {
  for (const name of FLAGS) delete process.env[name];
});
it('advertises nothing while every feature flag is off', () => {
  expect(workEntryLinks()).toEqual([]);
});
it('advertises only the pages whose own flag is exactly "true"', () => {
  process.env.WORK_WORKSPACE_READS_ENABLED = 'true';
  process.env.NOTIFICATIONS_READS_ENABLED = '1';
  expect(workEntryLinks().map((l) => l.href)).toEqual(['/raider/work', '/creator/work']);
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  process.env.NOTIFICATIONS_READS_ENABLED = 'true';
  expect(workEntryLinks().map((l) => l.href)).toEqual([
    '/raider/work',
    '/creator/work',
    '/creator/work/new',
    '/notifications',
  ]);
});
it('only links to in-product paths', () => {
  process.env.WORK_WORKSPACE_READS_ENABLED = 'true';
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  process.env.NOTIFICATIONS_READS_ENABLED = 'true';
  for (const link of workEntryLinks()) expect(link.href).toMatch(/^\/[a-z/]+$/);
});
