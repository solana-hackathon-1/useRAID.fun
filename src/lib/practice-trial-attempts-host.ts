import {
  startPracticeTrial,
  type StartPracticeTrialCommand,
} from '../skills/practice-trial-attempt-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
export function practiceTrialAttemptWriteConfiguration() {
  const writesAvailable = process.env.PRACTICE_TRIAL_ATTEMPTS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function startPracticeTrialFromHost(command: StartPracticeTrialCommand) {
  const result = await runCommandTransaction(db, (tx) =>
    startPracticeTrial(tx, command, {
      allowNewWrites: practiceTrialAttemptWriteConfiguration().writesAvailable,
    }),
  );
  return { version: 'v1' as const, ...result, ...practiceTrialAttemptWriteConfiguration() };
}
