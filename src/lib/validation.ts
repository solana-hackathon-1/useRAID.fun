import { z } from 'zod';
import { validMint } from './domain';
export const raidInput = z.object({
  projectType: z.enum(['TOKEN', 'PROJECT']).default('TOKEN'),
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(20).max(2000),
  mint: z.string().optional(),
  fundingRequest: z.string().trim().max(2000).default(''),
  fundingTermsAccepted: z.boolean().optional(),
  impressionTarget: z.coerce.number().int().min(1000).max(1_000_000_000).optional(),
  symbol: z.string().trim().min(1).max(15),
  name: z.string().trim().min(1).max(80),
  duration: z.coerce.number().int().min(1).max(72).default(24),
  startsAt: z.string().datetime().optional(),
}).superRefine((value, ctx) => {
  if (value.projectType === 'TOKEN' && (!value.mint || !validMint(value.mint)))
    ctx.addIssue({ code: 'custom', path: ['mint'], message: 'Enter a valid Solana mint address.' });
  if (value.projectType === 'PROJECT' && value.fundingRequest.length < 20)
    ctx.addIssue({ code: 'custom', path: ['fundingRequest'], message: 'Describe how you will fund this Raid (at least 20 characters).' });
  if (value.projectType === 'PROJECT' && !value.impressionTarget)
    ctx.addIssue({ code: 'custom', path: ['impressionTarget'], message: 'Choose your impression target.' });
  if (value.projectType === 'PROJECT' && !value.fundingTermsAccepted)
    ctx.addIssue({ code: 'custom', path: ['fundingTermsAccepted'], message: 'Accept funding terms.' });
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
