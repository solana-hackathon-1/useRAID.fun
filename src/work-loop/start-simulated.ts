import { canonicalRequestDigest } from '../command-receipts';
import type { StartHost } from './start-contracts';

/**
 * Reference host for simulated funding: the binding is the canonical `WorkSimulatedReservation` recorded at
 * publication, and public work needs no provisioned resources. Live custody and private resources need their own
 * hosts; this one never implies a real balance.
 */
export function simulatedStartHost(allowNewWrites: boolean): StartHost {
  return {
    allowNewWrites,
    async verifyBinding(tx, binding) {
      const rows = await tx.query(
        'SELECT 1 FROM "WorkSimulatedReservation" WHERE "slotId"=$1::uuid AND "termsVersionId"=$2::uuid AND "fundingRef"=$3 AND "vectorDigest"=$4',
        [
          binding.slotId,
          binding.termsVersionId,
          binding.fundingRef,
          canonicalRequestDigest(binding.terms.rewards),
        ],
      );
      return rows.length === 1;
    },
    async resourcesReady(_tx, context) {
      return context.terms.visibility === 'PUBLIC';
    },
  };
}
