import { InternalId } from '../contracts/ids';
import { PracticePortalError } from '../skills/practice-portal-contracts';
import {
  listOwnPracticeTrials,
  readOwnPracticeTrialProgress,
} from '../skills/practice-portal-storage';
import {
  startPracticeTrial,
  type StartPracticeTrialCommand,
} from '../skills/practice-trial-attempt-storage';
import {
  submitPracticeTrial,
  type SubmitPracticeTrialCommand,
} from '../skills/practice-trial-submission-storage';
import type { SkillTaxonomyActor } from '../skills/taxonomy-storage-contracts';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
function catalogId() {
  const p = InternalId.safeParse(process.env.PRACTICE_TRIAL_CATALOG_ID);
  return p.success ? p.data : null;
}
export function practicePortalReadConfiguration() {
  const readsAvailable =
    process.env.PRACTICE_PORTAL_READS_ENABLED === 'true' && catalogId() !== null;
  return {
    readsAvailable,
    unavailableReason: readsAvailable
      ? null
      : process.env.PRACTICE_PORTAL_READS_ENABLED === 'true'
        ? ('MISCONFIGURED' as const)
        : ('DISABLED' as const),
  };
}
function requireRead() {
  if (!practicePortalReadConfiguration().readsAvailable)
    throw new PracticePortalError('STORAGE_UNAVAILABLE');
}
export async function listPracticeTrialsFromHost(actor: SkillTaxonomyActor, after: string | null) {
  requireRead();
  const id = catalogId()!;
  const result = await runCommandTransaction(db, (tx) =>
    listOwnPracticeTrials(
      tx,
      actor,
      { version: 'v1', taxonomyId: id, after },
      () => practicePortalReadConfiguration().readsAvailable && catalogId() === id,
    ),
  );
  requireRead();
  if (catalogId() !== id) throw new PracticePortalError('STORAGE_UNAVAILABLE');
  return result;
}
export async function readPracticeProgressFromHost(actor: SkillTaxonomyActor, id: string) {
  requireRead();
  const result = await runCommandTransaction(db, (tx) =>
    readOwnPracticeTrialProgress(
      tx,
      actor,
      id,
      () => practicePortalReadConfiguration().readsAvailable,
    ),
  );
  requireRead();
  return result;
}
function writeConfig(flag: string) {
  const writesAvailable = process.env[flag] === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function startPracticeTrialFromPortal(command: StartPracticeTrialCommand) {
  requireRead();
  const result = await runCommandTransaction(db, (tx) =>
    startPracticeTrial(tx, command, {
      allowNewWrites: writeConfig('PRACTICE_TRIAL_ATTEMPTS_ENABLED').writesAvailable,
      canStart: (scope) =>
        practicePortalReadConfiguration().readsAvailable &&
        writeConfig('PRACTICE_TRIAL_ATTEMPTS_ENABLED').writesAvailable &&
        scope.taxonomyId === catalogId(),
    }),
  );
  requireRead();
  return { version: 'v1' as const, ...result, ...writeConfig('PRACTICE_TRIAL_ATTEMPTS_ENABLED') };
}
export async function submitPracticeTrialFromPortal(command: SubmitPracticeTrialCommand) {
  requireRead();
  const result = await runCommandTransaction(db, (tx) =>
    submitPracticeTrial(tx, command, {
      allowNewWrites: writeConfig('PRACTICE_TRIAL_SUBMISSIONS_ENABLED').writesAvailable,
      canSubmit: () =>
        practicePortalReadConfiguration().readsAvailable &&
        writeConfig('PRACTICE_TRIAL_SUBMISSIONS_ENABLED').writesAvailable,
    }),
  );
  requireRead();
  return {
    version: 'v1' as const,
    ...result,
    ...writeConfig('PRACTICE_TRIAL_SUBMISSIONS_ENABLED'),
  };
}
