import { Commitment, Connection } from '@solana/web3.js';
import { OutboundFetchError, boundedRpcFetch } from './outbound-fetch';

/**
 * The only place a Solana RPC `Connection` is built (DEC-2026-11-07-01 i, blueprint §28.3). Its transport is
 * `boundedRpcFetch`: https only, redirects refused, replies size-limited. Host dependency: `SOLANA_RPC_URL`, read by
 * callers. Websocket subscriptions are not used and not offered here (the custom fetch covers HTTP JSON-RPC only).
 */
export function solanaConnection(endpoint: string, commitment: Commitment = 'finalized') {
  if (!/^https:\/\//i.test(endpoint))
    throw new OutboundFetchError('insecure_url', 'Solana RPC must use https.');
  return new Connection(endpoint, { commitment, fetch: boundedRpcFetch });
}
