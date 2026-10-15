import {
  publishPracticeTrialDefinition,
  type PublishPracticeTrialCommand,
} from '../skills/practice-trial-storage';
import { adminXIds } from './admins';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
export function practiceTrialWriteConfiguration() {
  const writesAvailable = process.env.PRACTICE_TRIAL_PUBLICATION_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function publishPracticeTrialFromHost(command: PublishPracticeTrialCommand) {
  const result = await runCommandTransaction(db, (tx) =>
    publishPracticeTrialDefinition(tx, command, {
      allowNewWrites: practiceTrialWriteConfiguration().writesAvailable,
      canPublish: ({ xId }) => adminXIds().includes(xId),
    }),
  );
  return { version: 'v1' as const, ...result, ...practiceTrialWriteConfiguration() };
}
