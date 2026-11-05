import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
// This host owns its database. It never loads RAID configuration or the application client.
const url = new URL(process.env.DATABASE_URL ?? 'http://missing');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert(/^\/useraid_party_storage_host_test(_[a-z0-9]+)*$/.test(url.pathname));
assert.notEqual(process.env.NODE_ENV, 'production');
export const databaseUrl = url.toString();
export const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
