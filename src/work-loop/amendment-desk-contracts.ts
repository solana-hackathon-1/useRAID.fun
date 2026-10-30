import { z } from 'zod';
import { TermsSnapshotSchema } from '../contracts/entities';
import { AmendmentSchema } from './amendment-contracts';

/**
 * Own-view read model for the amendment desk: the engagements the caller can still amend or consent on, with every
 * recorded version of their terms. `effectiveTerms` is the member's own current promise and is null for a Founder.
 * `proposalsAvailable` is the host's write switch; reads stay available when it is off.
 */
export const AmendmentDeskSchema = z.strictObject({
  version: z.literal('v1'),
  proposalsAvailable: z.boolean(),
  engagements: z
    .array(
      z.strictObject({
        engagementId: z.uuid(),
        title: z.string().min(1).max(200),
        state: z.enum(['ACCESS_PENDING', 'IN_PROGRESS']),
        role: z.enum(['MEMBER', 'FOUNDER']),
        effectiveTerms: TermsSnapshotSchema.nullable(),
        amendments: z.array(AmendmentSchema).max(50),
      }),
    )
    .max(20),
});
export type AmendmentDesk = z.infer<typeof AmendmentDeskSchema>;
