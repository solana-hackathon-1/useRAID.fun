import bs58 from 'bs58';
import {
  type MeteoraDbcClient,
  type MeteoraPoolObservation,
  type MeteoraTxObservation,
} from '../../src/launch-route';

// Synthetic, test-only values. Nothing here is a proposed supply, fee, curve or allocation.
export const addr = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
export const FOUNDER = addr(11);
export const FEE_CLAIMER = addr(12);
export const MINT = addr(13);
export const POOL = addr(14);
export const DAMM_POOL = addr(15);
export const T0 = new Date('2026-11-07T12:00:00.000Z');

export const request = (over: Record<string, unknown> = {}) => ({
  intentId: 'intent-1',
  founderWallet: FOUNDER,
  metadata: { name: 'Fixture Guild', symbol: 'FIX', uri: 'https://example.invalid/meta.json' },
  ...over,
});
export const economics = (over: Record<string, unknown> = {}) => ({
  decisionRef: 'test-only-decision-reference',
  feeClaimer: FEE_CLAIMER,
  graduation: 'DAMM_V2' as const,
  configParameters: { placeholderA: 'x', nested: { b: '1', a: '2' } },
  ...over,
});

export function pool(over: Partial<MeteoraPoolObservation> = {}): MeteoraPoolObservation {
  return {
    programId: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
    mint: MINT,
    quoteMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    feeClaimer: FEE_CLAIMER,
    migrationProgress: 0,
    quoteReserve: '0',
    migrationQuoteThreshold: '1',
    tokenUpdateAuthority: 'CREATOR',
    observedAt: '2026-11-07T12:00:05.000Z',
    ...over,
  };
}

export class Fault extends Error {
  constructor(public code: string) {
    super('provider text that must never reach callers');
  }
}

export function mockClient(
  state: {
    tx?: MeteoraTxObservation['state'][];
    pool?: MeteoraPoolObservation | null;
    fail?: Partial<Record<'quote' | 'build' | 'tx' | 'pool', unknown>>;
    txCount?: number;
  } = {},
) {
  const calls = { quote: 0, build: 0, tx: 0, pool: 0 };
  const client: MeteoraDbcClient = {
    async quote() {
      calls.quote++;
      if (state.fail?.quote) throw state.fail.quote;
      return { quoteId: 'q-1', expiresAt: '2026-11-07T12:01:00.000Z', amounts: { fee: '7' } };
    },
    async buildUnsignedLaunch() {
      calls.build++;
      if (state.fail?.build) throw state.fail.build;
      return {
        mint: MINT,
        pool: POOL,
        transactions: Array.from({ length: state.txCount ?? 2 }, (_, i) => ({
          serializedBase64: `AAAA${i}`,
          description: `step ${i + 1}`,
        })),
      };
    },
    async getTransactionStatus(signature: string) {
      const i = calls.tx++;
      if (state.fail?.tx) throw state.fail.tx;
      return { signature, state: (state.tx ?? ['UNKNOWN'])[i % (state.tx ?? ['UNKNOWN']).length] };
    },
    async getPoolState() {
      calls.pool++;
      if (state.fail?.pool) throw state.fail.pool;
      return state.pool === undefined ? pool() : state.pool;
    },
  };
  return { client, calls };
}
