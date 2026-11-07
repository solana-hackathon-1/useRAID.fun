import bs58 from 'bs58';
import { createHash } from 'node:crypto';
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
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
/** Synthetic recorded-decision reference; the shipped registry is empty, tests pass it explicitly. */
export const DEC = 'DEC-2030-01-01-01';
/** sha256 of the canonical (sorted-key) JSON of the default `economics().configParameters`. */
export const CONFIG_HASH = createHash('sha256')
  .update('{"nested":{"a":"2","b":"1"},"placeholderA":"x"}')
  .digest('hex');
export const T0 = new Date('2026-11-07T12:00:00.000Z');

export const request = (over: Record<string, unknown> = {}) => ({
  intentId: 'intent-1',
  founderWallet: FOUNDER,
  metadata: { name: 'Fixture Guild', symbol: 'FIX', uri: 'https://example.invalid/meta.json' },
  ...over,
});
export const economics = (over: Record<string, unknown> = {}) => ({
  decisionRef: DEC,
  feeClaimer: FEE_CLAIMER,
  graduation: 'DAMM_V2' as const,
  configParameters: { placeholderA: 'x', nested: { b: '1', a: '2' } },
  ...over,
});

export function pool(over: Partial<MeteoraPoolObservation> = {}): MeteoraPoolObservation {
  return {
    programId: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
    pool: POOL,
    mint: MINT,
    creator: FOUNDER,
    configHash: CONFIG_HASH,
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

type Quote = {
  quoteId: string;
  expiresAt: string;
  parameterHash: string;
  amounts: Record<string, string>;
};
export function mockClient(
  state: {
    tx?: MeteoraTxObservation['state'][];
    /** Overrides merged into every transaction observation (binding fields). */
    txBinding?: Partial<MeteoraTxObservation>;
    pool?: MeteoraPoolObservation | null;
    fail?: Partial<Record<'quote' | 'build' | 'tx' | 'pool' | 'genesis' | 'getQuote', unknown>>;
    txCount?: number;
    genesis?: unknown;
    /** Rewrites the provider's authoritative record of an issued quote (null = unknown quote). */
    providerQuote?: (issued: Quote) => Quote | null;
    /** Overrides merged into the unsigned-build result. */
    built?: Record<string, unknown>;
    quoteAmounts?: Record<string, unknown>;
  } = {},
) {
  const calls = { genesis: 0, quote: 0, getQuote: 0, build: 0, tx: 0, pool: 0 };
  const issued = new Map<string, Quote>();
  const client: MeteoraDbcClient = {
    async getGenesisHash() {
      calls.genesis++;
      if (state.fail?.genesis) throw state.fail.genesis;
      return ('genesis' in state ? state.genesis : DEVNET_GENESIS) as string;
    },
    async quote(parameters) {
      calls.quote++;
      if (state.fail?.quote) throw state.fail.quote;
      const amounts = (state.quoteAmounts ?? { fee: '7' }) as Record<string, string>;
      const q = {
        quoteId: 'q-1',
        expiresAt: '2026-11-07T12:01:00.000Z',
        parameterHash: parameters.parameterHash,
        amounts,
      };
      issued.set(q.quoteId, q);
      return { quoteId: q.quoteId, expiresAt: q.expiresAt, amounts };
    },
    async getQuote(quoteId: string) {
      calls.getQuote++;
      if (state.fail?.getQuote) throw state.fail.getQuote;
      const q = issued.get(quoteId);
      if (!q) return null;
      return state.providerQuote ? state.providerQuote(q) : q;
    },
    async buildUnsignedLaunch(parameters, quoteId) {
      calls.build++;
      if (state.fail?.build) throw state.fail.build;
      const q = issued.get(quoteId);
      return {
        mint: MINT,
        pool: POOL,
        parameterHash: parameters.parameterHash,
        quoteId,
        amounts: q?.amounts ?? {},
        transactions: Array.from({ length: state.txCount ?? 2 }, (_, i) => ({
          serializedBase64: `AAAA${i}`,
          description: `step ${i + 1}`,
        })),
        ...state.built,
      } as never;
    },
    async getTransactionStatus(signature: string) {
      const i = calls.tx++;
      if (state.fail?.tx) throw state.fail.tx;
      return {
        signature,
        state: (state.tx ?? ['UNKNOWN'])[i % (state.tx ?? ['UNKNOWN']).length],
        programId: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
        mint: MINT,
        pool: POOL,
        signer: FOUNDER,
        ...state.txBinding,
      } as MeteoraTxObservation;
    },
    async getPoolState() {
      calls.pool++;
      if (state.fail?.pool) throw state.fail.pool;
      return state.pool === undefined ? pool() : state.pool;
    },
  };
  return { client, calls };
}
