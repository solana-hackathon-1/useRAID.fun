import { z } from 'zod';
import { assetKey } from '../contracts/assets';
import {
  ProjectControlContextSchema,
  ProjectControlFactsSchema,
  type ProjectControlProofResult,
  type ProjectControlReason,
} from './control-attestation-contracts';
import { SavedGuildProjectProposalSchema } from './project-proposal-contracts';

// JavaScript timestamps preserve milliseconds; do not sign or compare silently truncated precision.
const ProposalSnapshotSchema = SavedGuildProjectProposalSchema.refine((proposal) => {
  const fraction = proposal.recordedAt.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});

/** Trusted server context. Coexists with v1; old signatures never acquire a proposal binding. */
export const ProjectProposalControlContextSchema = z
  .strictObject({
    version: z.literal('v2'),
    purpose: z.literal('EXISTING_PROJECT_PROPOSAL_CONTROL'),
    control: ProjectControlContextSchema,
    proposal: ProposalSnapshotSchema,
  })
  .refine(
    ({ control, proposal }) =>
      control.guildDraftId === proposal.guildDraftId.toLowerCase() &&
      control.draftRevision === proposal.draftRevision &&
      assetKey(control.assetId) === assetKey(proposal.candidateToken),
  )
  .readonly();
export const ProjectProposalControlFactsSchema = z.strictObject({
  version: z.literal('v2'),
  control: ProjectControlFactsSchema,
  proposal: ProposalSnapshotSchema.nullable(),
});
export type ProjectProposalControlContext = z.infer<typeof ProjectProposalControlContextSchema>;
export type ProjectProposalControlFacts = z.infer<typeof ProjectProposalControlFactsSchema>;
export type ProjectProposalControlProofResult = Readonly<
  Omit<ProjectControlProofResult, 'version' | 'reason'> & {
    version: 'v2';
    proposalId: string;
    proposalRevision: number;
    reason: ProjectControlReason | 'PROPOSAL_CHANGED';
  }
>;
