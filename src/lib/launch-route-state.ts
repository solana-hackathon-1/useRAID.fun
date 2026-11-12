import { HttpError } from './auth-primitives';
import { createMeteoraDbcLaunchRoute, ProviderFault, type MeteoraDbcClient } from '../launch-route';

/**
 * Host view of the launch route (DEC-2026-11-07-04, O01). The first route is Meteora Dynamic
 * Bonding Curve to DAMM v2 with a USDC quote, devnet only. While O02 and O08 are OPEN the route is
 * `NOT_CONFIGURED`: this module supplies no economics and no Meteora client, so it reads the
 * route's own capabilities and never invents a supply, allocation, curve or fee value.
 */
export const LAUNCH_NOT_CONFIGURED_MESSAGE = 'Token launch is not configured yet.';

/** No Meteora binding exists in the app; any provider call from an unconfigured route is a bug. */
const noProvider = (): never => {
  throw new ProviderFault('PROVIDER_UNAVAILABLE');
};
const inertClient: MeteoraDbcClient = {
  getGenesisHash: noProvider,
  quote: noProvider,
  getQuote: noProvider,
  buildUnsignedLaunch: noProvider,
  getTransactionStatus: noProvider,
  getPoolState: noProvider,
};

export interface LaunchRouteState {
  readonly configured: boolean;
  readonly protocol: 'METEORA_DBC';
  readonly network: 'DEVNET';
  readonly quoteAsset: 'USDC';
  /** Names of the OPEN decisions that keep the route unconfigured. */
  readonly openDecisions: readonly string[];
}

export function launchRouteState(): LaunchRouteState {
  const capabilities = createMeteoraDbcLaunchRoute({
    network: 'DEVNET',
    client: inertClient,
    now: () => new Date(),
  }).capabilities();
  return {
    configured: capabilities.configured,
    protocol: capabilities.protocol,
    network: capabilities.network,
    quoteAsset: 'USDC',
    openDecisions: capabilities.openDecisions,
  };
}

/**
 * Every new launch intent passes here. The retired Pump route takes none, and no other route has an
 * app binding yet, so this refuses for every caller until a reviewed change wires a configured
 * route. Existing intents are not covered: they stay pinned to their protocol and keep their own
 * status, submit, retry, renew and enroll paths.
 */
export function assertNewLaunchIntentsAllowed(): void {
  throw new HttpError(503, LAUNCH_NOT_CONFIGURED_MESSAGE);
}
