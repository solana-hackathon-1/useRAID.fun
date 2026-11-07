/**
 * Typed launch-route failures (blueprint 05.4). Messages are only the code, never provider or input
 * text. `NOT_CONFIGURED` is the controlled state while O02 and O08 are OPEN (DEC-2026-11-07-04).
 */
export const LAUNCH_ROUTE_ERROR_CODES = [
  'NOT_CONFIGURED',
  'NETWORK_REFUSED',
  'PROTOCOL_MISMATCH',
  'UNSUPPORTED_PARAMETERS',
  'QUOTE_EXPIRED',
  'INSUFFICIENT_FUNDS',
  'SIGNATURE_REJECTED',
  'TRANSACTION_UNKNOWN',
  'TRANSACTION_FAILED',
  'PARTIAL_COMPLETION',
  'PROVIDER_UNAVAILABLE',
  'INCONSISTENT_STATE',
] as const;
export type LaunchRouteErrorCode = (typeof LAUNCH_ROUTE_ERROR_CODES)[number];

/** Thrown only for programmer or deployment errors at construction (for example a non-devnet network). */
export class LaunchRouteError extends Error {
  readonly code: LaunchRouteErrorCode;
  constructor(code: LaunchRouteErrorCode) {
    super(code);
    this.name = 'LaunchRouteError';
    this.code = code;
  }
}

/** Codes a provider client may raise; anything else is treated as `PROVIDER_UNAVAILABLE`. */
export type ProviderFaultCode =
  'INSUFFICIENT_FUNDS' | 'UNSUPPORTED_PARAMETERS' | 'SIGNATURE_REJECTED' | 'PROVIDER_UNAVAILABLE';
export class ProviderFault extends Error {
  readonly code: ProviderFaultCode;
  constructor(code: ProviderFaultCode) {
    super(code);
    this.name = 'ProviderFault';
    this.code = code;
  }
}
