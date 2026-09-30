import { createRequire } from 'node:module';
// The installed SDK's ESM dependency imports a missing named CommonJS export.
// Its published CommonJS entry supports both the Node worker and server runtime.
const sdk = createRequire(import.meta.url)(
  '@pump-fun/pump-sdk',
) as typeof import('@pump-fun/pump-sdk');
export const {
  OnlinePumpSdk,
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  ammCreatorVaultPda,
  bondingCurvePda,
  canonicalPumpPoolPda,
  creatorVaultPda,
  getPumpAmmProgram,
} = sdk;
