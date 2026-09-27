import { z } from 'zod';
import { validMint } from './domain';
export const raidInput = z.object({
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(20).max(2000),
  mint: z.string().refine(validMint, 'Enter a valid Solana mint address.'),
  symbol: z.string().trim().min(1).max(15),
  name: z.string().trim().min(1).max(80),
  duration: z.coerce.number().int().min(1).max(72).default(24),
  startsAt: z.string().datetime().optional(),
});
export const settingsInput = z
  .object({
    collectionEnabled: z.boolean(),
    maxActiveRaids: z.number().int().min(1).max(10),
    maxCreators: z.number().int().min(1).max(5),
    monthlyBudgetCents: z.number().int().min(100).max(20000),
    cutoffCents: z.number().int().min(1).max(19000),
    dailyRequestLimit: z.number().int().min(1).max(5000),
  })
  .refine((x) => x.cutoffCents < x.monthlyBudgetCents, 'Cutoff must be below the budget.');
