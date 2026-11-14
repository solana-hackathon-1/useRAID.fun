import { WorkError, type WorkActor, type WorkCommand } from '../work-loop/contracts';
import type { EvidenceSnapshotHost, SkillRecord } from '../work-loop/evidence-snapshot-contracts';
import {
  recordEvidenceSnapshot,
  withdrawEvidenceSnapshot,
  readEvidenceSnapshot,
} from '../work-loop/evidence-snapshot-storage';
import { workEvidenceSnapshotEnabled } from './config';
import { runCommandTransaction } from './command-receipts-adapter';
import { isWorkOperator, workWorkspaceConfiguration } from './work-workspace-host';
import { db } from './db';

export interface RootEvidenceSnapshotConfig {
  allowNewWrites: boolean;
  /** Synthetic operator allowlist standing in for Guild authority, which the shared Root cannot recognize yet. */
  isOperator?: (accountId: string) => boolean;
}
/**
 * Evidence-snapshot host for the shared Root. Reviewer authority is the explicit synthetic operator allowlist
 * (`RAID_WORK_OPERATOR_ACCOUNT_IDS`) and the storage command additionally requires the listing's creator: this is NOT
 * Guild or production authority and the Guild id is deliberately ignored. The applicant's records are read from the
 * current version of their own skill assessments, for exactly the skills they chose: no evidence content, claim
 * references, files or links are ever selected. An assessment state this contract does not know is left out, so the
 * skill reads as NOT_ASSESSED instead of failing the share.
 */
export function createRootEvidenceSnapshotHost(
  config: RootEvidenceSnapshotConfig,
): EvidenceSnapshotHost {
  const isOperator = config.isOperator ?? isWorkOperator;
  return {
    allowNewWrites: config.allowNewWrites,
    authorize: async (_tx, actor) => isOperator(actor.accountId),
    async readSkillRecords(tx, subject, skillIds) {
      if (!skillIds.length) return [];
      const marks = skillIds.map((_, i) => `$${i + 2}`).join(',');
      return tx.query<SkillRecord>(
        `SELECT a."skillId",v."assessedRank" AS "rank",v."state" AS "status",to_char(v."issuedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assessedAt"
         FROM "SkillAssessment" a JOIN "SkillAssessmentVersion" v ON v."id"=a."currentVersionId"
         WHERE a."participantId"=$1::uuid AND v."state" IN ('VERIFIED','REASSESSMENT_REQUIRED','REVOKED') AND a."skillId" IN (${marks})`,
        [subject.participantId, ...skillIds],
      );
    },
  };
}
/**
 * `WORK_EVIDENCE_SNAPSHOT_ENABLED` (default off) and the workspace read switch gate taking and viewing a snapshot.
 * Withdrawing one needs no switch at all (still a real session and the applicant's own application): it reduces what is
 * shown, so no flag can trap consent.
 */
function requireEnabled() {
  if (!workWorkspaceConfiguration().readsAvailable || !workEvidenceSnapshotEnabled())
    throw new WorkError('WRITES_DISABLED');
}
const host = () =>
  createRootEvidenceSnapshotHost({ allowNewWrites: workEvidenceSnapshotEnabled() });
export async function readEvidenceSnapshotFromHost(actor: WorkActor, applicationId: string) {
  requireEnabled();
  const h = host();
  return runCommandTransaction(db, (tx) => readEvidenceSnapshot(tx, actor, applicationId, h));
}
export async function recordEvidenceSnapshotFromHost(command: WorkCommand) {
  requireEnabled();
  const h = host();
  return runCommandTransaction(db, (tx) => recordEvidenceSnapshot(tx, command, h));
}
export async function withdrawEvidenceSnapshotFromHost(command: WorkCommand) {
  return runCommandTransaction(db, (tx) => withdrawEvidenceSnapshot(tx, command));
}
