import {
  submitPracticeTrial,
  type SubmitPracticeTrialCommand,
} from '../skills/practice-trial-submission-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
export function practiceTrialSubmissionWriteConfiguration() {
  const writesAvailable = process.env.PRACTICE_TRIAL_SUBMISSIONS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function submitPracticeTrialFromHost(command: SubmitPracticeTrialCommand) {
  const result = await runCommandTransaction(db, (tx) =>
    submitPracticeTrial(tx, command, {
      allowNewWrites: practiceTrialSubmissionWriteConfiguration().writesAvailable,
    }),
  );
  return { version: 'v1' as const, ...result, ...practiceTrialSubmissionWriteConfiguration() };
}
