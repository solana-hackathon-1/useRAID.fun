import type { z } from 'zod';
import { createProjectControlMessage, evaluateProjectControlProof } from './control-attestation';
import {
  ProjectControlContractError,
  ProjectControlSignatureVerifierSchema,
  type ProjectControlVerificationInput,
} from './control-attestation-contracts';
import {
  ProjectProposalControlContextSchema,
  ProjectProposalControlFactsSchema,
  type ProjectProposalControlContext,
  type ProjectProposalControlProofResult,
} from './proposal-control-contracts';
import type { SavedGuildProjectProposal } from './project-proposal-contracts';
export * from './proposal-control-contracts';

function parseHost<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProjectControlContractError('INVALID_HOST_CONTRACT');
  return parsed.data;
}
function snapshot(p: SavedGuildProjectProposal) {
  // Fixed field order and timestamp normalization preserve canonical bytes across hosts.
  return {
    version: p.version,
    id: p.id.toLowerCase(),
    guildDraftId: p.guildDraftId.toLowerCase(),
    revision: p.revision,
    draftRevision: p.draftRevision,
    recordedAt: new Date(p.recordedAt).toISOString(),
    projectType: p.projectType,
    state: p.state,
    persisted: p.persisted,
    candidateToken: {
      chain: p.candidateToken.chain,
      networkIdentity: p.candidateToken.networkIdentity,
      kind: p.candidateToken.kind,
      mint: p.candidateToken.mint,
      tokenProgram: p.candidateToken.tokenProgram,
    },
    publicEvidenceRefs: p.publicEvidenceRefs,
    founderControlVerified: p.founderControlVerified,
    recognizesGuild: p.recognizesGuild,
    activatesToken: p.activatesToken,
    createsPermissionGrant: p.createsPermissionGrant,
    publicProfileApproved: p.publicProfileApproved,
  };
}
function encode(context: ProjectProposalControlContext): string {
  return (
    'RAID existing-project proposal control attestation v2\n' +
    JSON.stringify(
      {
        version: context.version,
        purpose: context.purpose,
        proposal: snapshot(context.proposal),
        controlMessage: createProjectControlMessage(context.control),
      },
      null,
      2,
    )
  );
}
export function createProjectProposalControlMessage(context: unknown): string {
  return encode(parseHost(ProjectProposalControlContextSchema, context));
}
/** Informational only; actual current records and atomic nonce/recognition remain host obligations. */
export function evaluateProjectProposalControlProof(
  contextValue: unknown,
  factsValue: unknown,
  inputValue: unknown,
  verifierValue: unknown,
): ProjectProposalControlProofResult {
  const context = parseHost(ProjectProposalControlContextSchema, contextValue);
  const facts = parseHost(ProjectProposalControlFactsSchema, factsValue);
  const verifier = parseHost(ProjectControlSignatureVerifierSchema, verifierValue);
  const matches =
    facts.proposal !== null &&
    JSON.stringify(snapshot(facts.proposal)) === JSON.stringify(snapshot(context.proposal));
  const result = evaluateProjectControlProof(context.control, facts.control, inputValue, {
    version: 'v1',
    algorithm: 'ED25519',
    verify(input: ProjectControlVerificationInput) {
      if (!matches) return false;
      return verifier.verify(Object.freeze({ ...input, message: encode(context) }));
    },
  });
  return Object.freeze({
    ...result,
    version: 'v2',
    proposalId: context.proposal.id.toLowerCase(),
    proposalRevision: context.proposal.revision,
    reason: !matches && result.reason === 'SIGNATURE_INVALID' ? 'PROPOSAL_CHANGED' : result.reason,
  });
}
