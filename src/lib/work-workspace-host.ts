import { WorkError, type WorkActor, type WorkCommand } from '../work-loop/contracts';
import type { AdmissionHost } from '../work-loop/admission-contracts';
import { submitWork, decideReview } from '../work-loop/submission-storage';
import { withdrawApplication, issueOffer, revokeOffer } from '../work-loop/admission-storage';
import { readMyRaids, readReviewQueue, readApplicantQueue } from '../work-loop/workspace-storage';
import { startEngagement } from '../work-loop/start-storage';
import { simulatedStartHost } from '../work-loop/start-simulated';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

const flag = (name: string) => process.env[name] === 'true';
export function workWorkspaceConfiguration() {
  return {
    readsAvailable: flag('WORK_WORKSPACE_READS_ENABLED'),
    submissionsAvailable: flag('WORK_SUBMISSIONS_ENABLED'),
    reviewsAvailable: flag('WORK_REVIEWS_ENABLED'),
    applicationsAvailable: flag('WORK_APPLICATIONS_ENABLED'),
    startsAvailable: flag('WORK_START_ENABLED'),
    offersAvailable: flag('WORK_ADMISSION_MANAGEMENT_ENABLED'),
  };
}
/**
 * Explicit synthetic-operator allowlist. The shared Root has no recognized Guild authority, so this is NOT
 * Guild or production authority: with the variable unset nobody can manage listings, and every flag is off by default.
 */
function operators() {
  return new Set(
    (process.env.RAID_WORK_OPERATOR_ACCOUNT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
function applicationLimit() {
  const value = Number(process.env.WORK_APPLICATION_LIMIT ?? 5);
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : 5;
}
function admission(allowNewWrites: boolean): AdmissionHost {
  return {
    allowNewWrites,
    applicationLimit: applicationLimit(),
    authorize: async (_tx, actor, _guildId, action) =>
      action === 'MANAGE_LISTING' && operators().has(actor.accountId),
  };
}
function requireReads() {
  if (!workWorkspaceConfiguration().readsAvailable) throw new WorkError('STORAGE_CONTRACT');
}
export async function readMyRaidsFromHost(actor: WorkActor) {
  requireReads();
  return runCommandTransaction(db, (tx) => readMyRaids(tx, actor));
}
export async function readReviewQueueFromHost(actor: WorkActor) {
  requireReads();
  return runCommandTransaction(db, (tx) => readReviewQueue(tx, actor));
}
export async function readApplicantQueueFromHost(actor: WorkActor) {
  requireReads();
  return runCommandTransaction(db, (tx) =>
    readApplicantQueue(tx, actor, admission(workWorkspaceConfiguration().offersAvailable)),
  );
}
export async function submitWorkFromHost(command: WorkCommand) {
  requireReads();
  const allowNewWrites = workWorkspaceConfiguration().submissionsAvailable;
  return runCommandTransaction(db, (tx) => submitWork(tx, command, { allowNewWrites }));
}
export async function decideReviewFromHost(command: WorkCommand) {
  requireReads();
  const allowNewWrites = workWorkspaceConfiguration().reviewsAvailable;
  return runCommandTransaction(db, (tx) => decideReview(tx, command, { allowNewWrites }));
}
export async function issueOfferFromHost(command: WorkCommand) {
  requireReads();
  const host = admission(workWorkspaceConfiguration().offersAvailable);
  return runCommandTransaction(db, (tx) => issueOffer(tx, command, host));
}
export async function revokeOfferFromHost(command: WorkCommand) {
  requireReads();
  const host = admission(workWorkspaceConfiguration().offersAvailable);
  return runCommandTransaction(db, (tx) => revokeOffer(tx, command, host));
}
export async function withdrawApplicationFromHost(command: WorkCommand) {
  requireReads();
  const host = admission(workWorkspaceConfiguration().applicationsAvailable);
  return runCommandTransaction(db, (tx) => withdrawApplication(tx, command, host));
}
export async function startEngagementFromHost(command: WorkCommand) {
  requireReads();
  const host = simulatedStartHost(workWorkspaceConfiguration().startsAvailable);
  return runCommandTransaction(db, (tx) => startEngagement(tx, command, host));
}
