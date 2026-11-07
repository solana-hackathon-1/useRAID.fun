import { Connection } from '@solana/web3.js';

export function solanaConnection(endpoint: string) {
  return new Connection(endpoint, 'finalized');
}
