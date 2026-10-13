import { db } from './db';
import { runCommandTransaction } from './command-receipts-adapter';
import { OrientationCatalogSchema } from '../raider-onboarding/host-contracts';
import { config } from './config';
import {
  readRaiderOrientation,
  saveRaiderOrientation,
  type OrientationActor,
  type SaveOrientationCommand,
} from '../raider-onboarding/storage';
import type { RaiderOnboardingHost } from '../raider-onboarding';
/** Explicit host bootstrap catalog; these interests are not assessed skills or policy. */
export function orientationCatalog(env: Record<string, string | undefined> = process.env) {
  const raw = env.RAIDER_ONBOARDING_CATALOG;
  if (!raw || raw.length > 100000) return [];
  try {
    const parsed = OrientationCatalogSchema.min(1).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
export function orientationWriteConfiguration() {
  const catalog = orientationCatalog();
  const enabled = !config.demo && process.env.RAIDER_ONBOARDING_ENABLED === 'true';
  return {
    catalog,
    writesAvailable: enabled && catalog.length > 0,
    unavailableReason: !enabled
      ? ('DISABLED' as const)
      : catalog.length === 0
        ? ('NOT_CONFIGURED' as const)
        : null,
  };
}
function contract(catalog: { id: string }[]): RaiderOnboardingHost {
  return {
    version: 'v1',
    interestIds: catalog.map((i) => i.id),
    nextActions: {
      starterTasks: { available: false, reason: 'NOT_READY' },
      portfolio: { available: false, reason: 'NOT_READY' },
      trial: { available: false, reason: 'NOT_READY' },
    },
  };
}
export async function readOrientationState(actor: OrientationActor) {
  const orientation = await runCommandTransaction(db, (tx) => readRaiderOrientation(tx, actor));
  return { version: 'v1' as const, orientation, ...orientationWriteConfiguration() };
}
export async function saveOrientation(command: SaveOrientationCommand) {
  const options = orientationWriteConfiguration();
  return runCommandTransaction(db, (tx) =>
    saveRaiderOrientation(tx, command, contract(options.catalog), {
      allowNewWrites: options.writesAvailable,
    }),
  );
}
