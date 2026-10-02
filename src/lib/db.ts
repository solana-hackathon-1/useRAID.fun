import { PrismaClient } from '@prisma/client';
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db =
  globalDb.prisma ?? new PrismaClient({ transactionOptions: { maxWait: 10000, timeout: 30000 } });
if (process.env.NODE_ENV !== 'production') globalDb.prisma = db;
