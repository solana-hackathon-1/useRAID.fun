export type AssetRegistryErrorCode =
  | 'INVALID_AMOUNT'
  | 'EXCESS_PRECISION'
  | 'AMOUNT_OVERFLOW'
  | 'AMOUNT_UNDERFLOW'
  | 'INVALID_ALLOCATION'
  | 'INVALID_ASSET_ID'
  | 'UNSUPPORTED_ASSET'
  | 'ASSET_MISMATCH'
  | 'ASSET_POLICY_CHANGED'
  | 'CONFLICTING_OBSERVATION'
  | 'INVALID_CONFIGURATION'
  | 'PRODUCTION_BLOCKED';
export type ProductionViolation = { code: string; subject?: string };
export class AssetRegistryError extends Error {
  readonly code: AssetRegistryErrorCode;
  violations?: readonly ProductionViolation[];
  constructor(code: AssetRegistryErrorCode) {
    super(code);
    this.name = 'AssetRegistryError';
    this.code = code;
  }
}
