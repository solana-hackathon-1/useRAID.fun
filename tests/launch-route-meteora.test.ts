import { describe, expect, it } from 'vitest';
import {
  LaunchRouteError,
  METEORA_DBC_PROGRAM_ID,
  ProviderFault,
  createMeteoraDbcLaunchRoute,
  type LaunchRoute,
} from '../src/launch-route';
import { createMeteoraDbcLaunchRouteWithDecisions } from '../src/launch-route/meteora-dbc';
import {
  DAMM_POOL,
  DEC,
  FEE_CLAIMER,
  MINT,
  POOL,
  T0,
  addr,
  economics,
  mockClient,
  pool,
  request,
} from './helpers/launch-route-fixtures';

const DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const build = (
  state: Parameters<typeof mockClient>[0] = {},
  configured = true,
  clock = { now: T0 },
) => {
  const m = mockClient(state);
  const route = createMeteoraDbcLaunchRouteWithDecisions(
    {
      network: 'DEVNET',
      client: m.client,
      now: () => clock.now,
      ...(configured ? { economics: economics() } : {}),
    },
    [DEC],
  );
  return { ...m, route, clock };
};
async function intentOf(route: LaunchRoute) {
  const q = await route.quoteLaunch(request());
  if (!q.ok) throw new Error('quote');
  const p = await route.prepareLaunch(request(), q.value);
  if (!p.ok) throw new Error('prepare');
  return p.value.intent;
}
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'OK' : r.error!.code);

describe('T026 Meteora DBC launch route adapter (DEC-2026-11-07-04, R15)', () => {
  describe('controlled not-configured state while O02 and O08 are OPEN', () => {
    it('every operation reports NOT_CONFIGURED naming the open decisions and never calls the provider', async () => {
      const { route, calls } = build({}, false);
      const intent = {} as never;
      const results = [
        await route.validateLaunch(request()),
        await route.quoteLaunch(request()),
        await route.prepareLaunch(request(), {} as never),
        await route.verifyLaunch(intent, ['s']),
        await route.getMarketStatus(intent),
        await route.reconcileLaunch(intent, ['s']),
      ];
      for (const r of results) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('NOT_CONFIGURED');
          expect(r.error.detail).toEqual(['O02', 'O08']);
        }
      }
      expect(calls).toEqual({ genesis: 0, quote: 0, getQuote: 0, build: 0, tx: 0, pool: 0 });
      expect(route.capabilities().configured).toBe(false);
    });
    it('ships no default economics: configuring requires host-supplied economics', () => {
      const m = mockClient();
      const route = createMeteoraDbcLaunchRoute({
        network: 'DEVNET',
        client: m.client,
        now: () => T0,
      });
      expect(route.capabilities().configured).toBe(false);
      expect(route.capabilities().openDecisions).toEqual(['O02', 'O08']);
    });
  });

  describe('devnet only, refused in code', () => {
    it.each([
      ['MAINNET'],
      ['mainnet-beta'],
      ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'],
      [undefined],
      ['TESTNET'],
    ])('refuses network %s at construction', (network) => {
      const m = mockClient();
      let thrown: unknown;
      try {
        createMeteoraDbcLaunchRoute({ network: network as never, client: m.client, now: () => T0 });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(LaunchRouteError);
      expect((thrown as LaunchRouteError).code).toBe('NETWORK_REFUSED');
      expect((thrown as Error).message).toBe('NETWORK_REFUSED');
    });
    it('pins the documented DBC program id and USDC devnet quote', () => {
      const { route } = build();
      const caps = route.capabilities();
      expect(caps.programId).toBe(METEORA_DBC_PROGRAM_ID);
      expect(caps.network).toBe('DEVNET');
      expect(caps.quoteAsset.mint).toBe(DEVNET_MINT);
      expect(caps.protocol).toBe('METEORA_DBC');
    });
  });

  describe('validateLaunch', () => {
    it('returns a deterministic parameter hash independent of key order and sensitive to content', async () => {
      const a = build().route;
      const r1 = await a.validateLaunch(request());
      const r2 = await a.validateLaunch(request());
      expect(r1.ok && r2.ok && r1.value.parameterHash === r2.value.parameterHash).toBe(true);
      const m = mockClient();
      const reordered = createMeteoraDbcLaunchRouteWithDecisions(
        {
          network: 'DEVNET',
          client: m.client,
          now: () => T0,
          economics: economics({
            configParameters: { nested: { a: '2', b: '1' }, placeholderA: 'x' },
          }),
        },
        [DEC],
      );
      const r3 = await reordered.validateLaunch(request());
      expect(r3.ok && r1.ok && r3.value.parameterHash === r1.value.parameterHash).toBe(true);
      const r4 = await a.validateLaunch(
        request({
          metadata: { name: 'Other', symbol: 'FIX', uri: 'https://example.invalid/meta.json' },
        }),
      );
      expect(r4.ok && r1.ok && r4.value.parameterHash !== r1.value.parameterHash).toBe(true);
    });
    it.each([
      ['bad wallet', { founderWallet: 'not-an-address' }],
      ['empty name', { metadata: { name: '', symbol: 'F', uri: 'https://x.invalid/m' } }],
      ['non-https uri', { metadata: { name: 'n', symbol: 'F', uri: 'javascript:alert(1)' } }],
      ['bad intent id', { intentId: '' }],
    ])('rejects %s as UNSUPPORTED_PARAMETERS', async (_name, over) => {
      const { route } = build();
      expect(code(await route.validateLaunch(request(over)))).toBe('UNSUPPORTED_PARAMETERS');
    });
    it('rejects economics that change the quote asset, graduation target or are not canonical JSON', async () => {
      for (const bad of [
        economics({ configParameters: { quoteMint: addr(99) } }),
        economics({ graduation: 'DAMM_V1' }),
        economics({ feeClaimer: 'nope' }),
        economics({ configParameters: { n: Number.NaN } }),
        economics({ configParameters: { n: 10n } }),
        economics({ configParameters: { f() {} } }),
      ]) {
        const m = mockClient();
        const route = createMeteoraDbcLaunchRouteWithDecisions(
          {
            network: 'DEVNET',
            client: m.client,
            now: () => T0,
            economics: bad as never,
          },
          [DEC],
        );
        expect(code(await route.validateLaunch(request()))).toBe('UNSUPPORTED_PARAMETERS');
      }
    });
    it('never echoes input text in a failure', async () => {
      const { route } = build();
      const r = await route.validateLaunch(request({ founderWallet: 'SECRET-LOOKING-TEXT' }));
      expect(JSON.stringify(r)).not.toContain('SECRET-LOOKING-TEXT');
    });
  });

  describe('quote and prepare', () => {
    it('quotes via the provider and prepares an unsigned, pinned intent', async () => {
      const { route, calls } = build();
      const q = await route.quoteLaunch(request());
      expect(q.ok && q.value.expiresAt).toBe('2026-11-07T12:01:00.000Z');
      if (!q.ok) return;
      const p = await route.prepareLaunch(request(), q.value);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.value.signed).toBe(false);
      expect(p.value.transactions).toHaveLength(2);
      expect(p.value.intent).toMatchObject({
        protocol: 'METEORA_DBC',
        programId: METEORA_DBC_PROGRAM_ID,
        network: 'DEVNET',
        quoteMint: DEVNET_MINT,
        feeClaimer: FEE_CLAIMER,
        mint: MINT,
        pool: POOL,
        transactionCount: 2,
      });
      expect(p.value.intent.parameterHash).toMatch(/^[0-9a-f]{64}$/);
      expect(calls.quote).toBe(1);
      expect(calls.build).toBe(1);
    });
    it('refuses to prepare from an expired quote and never calls the builder', async () => {
      const { route, calls, clock } = build();
      const q = await route.quoteLaunch(request());
      if (!q.ok) throw new Error('quote');
      clock.now = new Date('2026-11-07T12:01:00.000Z');
      expect(code(await route.prepareLaunch(request(), q.value))).toBe('QUOTE_EXPIRED');
      expect(calls.build).toBe(0);
    });
    it('refuses a quote that belongs to different parameters', async () => {
      const { route } = build();
      const q = await route.quoteLaunch(request());
      if (!q.ok) throw new Error('quote');
      const other = request({
        metadata: { name: 'Different', symbol: 'D', uri: 'https://x.invalid/m' },
      });
      expect(code(await route.prepareLaunch(other, q.value))).toBe('INCONSISTENT_STATE');
    });
    it.each([
      [new ProviderFault('INSUFFICIENT_FUNDS'), 'INSUFFICIENT_FUNDS'],
      [new ProviderFault('UNSUPPORTED_PARAMETERS'), 'UNSUPPORTED_PARAMETERS'],
      [new ProviderFault('SIGNATURE_REJECTED'), 'SIGNATURE_REJECTED'],
      [new Error('socket hang up'), 'PROVIDER_UNAVAILABLE'],
      [new ProviderFault('SOMETHING_NEW' as never), 'PROVIDER_UNAVAILABLE'],
    ])('maps provider failure %# to %s without leaking text', async (fault, expected) => {
      const { route } = build({ fail: { build: fault } });
      const q = await route.quoteLaunch(request());
      if (!q.ok) throw new Error('quote');
      const r = await route.prepareLaunch(request(), q.value);
      expect(code(r)).toBe(expected);
      expect(JSON.stringify(r)).not.toContain('socket');
    });
    it('maps a quote failure to PROVIDER_UNAVAILABLE', async () => {
      const { route } = build({ fail: { quote: new Error('boom') } });
      expect(code(await route.quoteLaunch(request()))).toBe('PROVIDER_UNAVAILABLE');
    });
  });

  describe('verifyLaunch', () => {
    it('unknown signatures are TRANSACTION_UNKNOWN, never a guess', async () => {
      const { route } = build({ tx: ['UNKNOWN'] });
      const intent = await intentOf(route);
      expect(code(await route.verifyLaunch(intent, ['a', 'b']))).toBe('TRANSACTION_UNKNOWN');
    });
    it('intermediate commitment is CONFIRMED_PENDING_FINALITY', async () => {
      const { route } = build({ tx: ['CONFIRMED', 'PROCESSED'] });
      const intent = await intentOf(route);
      const r = await route.verifyLaunch(intent, ['a', 'b']);
      expect(r.ok && r.value.state).toBe('CONFIRMED_PENDING_FINALITY');
    });
    it('a failed transaction is TRANSACTION_FAILED; finalized plus failed is PARTIAL_COMPLETION', async () => {
      const failed = build({ tx: ['FAILED', 'FAILED'] });
      expect(code(await failed.route.verifyLaunch(await intentOf(failed.route), ['a', 'b']))).toBe(
        'TRANSACTION_FAILED',
      );
      const partial = build({ tx: ['FINALIZED', 'FAILED'] });
      expect(
        code(await partial.route.verifyLaunch(await intentOf(partial.route), ['a', 'b'])),
      ).toBe('PARTIAL_COMPLETION');
    });
    it('fewer signatures than prepared transactions is ACTION_REQUIRED, not LIVE', async () => {
      const { route, calls } = build({ tx: ['FINALIZED'] });
      const intent = await intentOf(route);
      const r = await route.verifyLaunch(intent, ['a']);
      expect(r.ok && r.value.state).toBe('ACTION_REQUIRED');
      expect(calls.pool).toBe(0);
    });
    it('LIVE only when finalized and the observed pool matches the pinned facts; reports authorities', async () => {
      const { route } = build({
        tx: ['FINALIZED'],
        pool: pool({ tokenUpdateAuthority: 'CREATOR' }),
      });
      const intent = await intentOf(route);
      const r = await route.verifyLaunch(intent, ['a', 'b']);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.state).toBe('LIVE');
      expect(r.value.facts).toMatchObject({
        network: 'DEVNET',
        programId: METEORA_DBC_PROGRAM_ID,
        mint: MINT,
        parameterHash: intent.parameterHash,
        authorities: { tokenUpdateAuthority: 'CREATOR' },
        observedAt: '2026-11-07T12:00:05.000Z',
      });
      expect(r.value.facts.transactionSignatures).toEqual(['a', 'b']);
    });
    it.each([
      ['missing pool', null],
      ['different mint', pool({ mint: addr(77) })],
      ['different program', pool({ programId: addr(78) })],
      ['different quote mint', pool({ quoteMint: addr(79) })],
      ['different fee claimer', pool({ feeClaimer: addr(80) })],
    ])('INCONSISTENT_STATE for %s', async (_n, observed) => {
      const { route } = build({ tx: ['FINALIZED'], pool: observed });
      const intent = await intentOf(route);
      expect(code(await route.verifyLaunch(intent, ['a', 'b']))).toBe('INCONSISTENT_STATE');
    });
    it('maps provider failure to PROVIDER_UNAVAILABLE', async () => {
      const { route } = build({ fail: { tx: new Error('rpc down') } });
      const intent = await intentOf(route);
      expect(code(await route.verifyLaunch(intent, ['a', 'b']))).toBe('PROVIDER_UNAVAILABLE');
    });
    it('does not rely on immutable metadata: a non-immutable authority is reported, not refused', async () => {
      const { route } = build({
        tx: ['FINALIZED'],
        pool: pool({ tokenUpdateAuthority: 'PARTNER' }),
      });
      const r = await route.verifyLaunch(await intentOf(route), ['a', 'b']);
      expect(r.ok && r.value.state).toBe('LIVE');
      const caps = route.capabilities().immutableMetadata;
      expect(caps).toMatchObject({ documented: true, relied: false, verifiedOnChain: false });
      expect(caps.source).toBe('https://docs.meteora.ag/developer-guides/dbc/program/accounts');
    });
  });

  describe('pinning: never silently switch protocol, program, network or mint', () => {
    it.each([
      ['protocol', { protocol: 'PUMP' }],
      ['program', { programId: addr(5) }],
      ['network', { network: 'MAINNET' }],
      ['quote mint', { quoteMint: addr(6) }],
    ])('refuses an intent pinned to a different %s', async (_n, over) => {
      const { route, calls } = build({ tx: ['FINALIZED'] });
      const intent = { ...(await intentOf(route)), ...over } as never;
      expect(code(await route.verifyLaunch(intent, ['a', 'b']))).toBe('PROTOCOL_MISMATCH');
      expect(code(await route.getMarketStatus(intent))).toBe('PROTOCOL_MISMATCH');
      expect(code(await route.reconcileLaunch(intent, ['a', 'b']))).toBe('PROTOCOL_MISMATCH');
      expect(calls.tx + calls.pool).toBe(0);
    });
  });

  describe('getMarketStatus uses provider-specific phases, not a progress bar', () => {
    it.each([
      [0, undefined, 'PRE_BONDING_CURVE', false],
      [1, undefined, 'POST_BONDING_CURVE', false],
      [2, undefined, 'LOCKED_VESTING', false],
      [3, undefined, 'CREATED_POOL', false],
      [3, DAMM_POOL, 'CREATED_POOL', true],
    ] as const)(
      'migrationProgress %s -> %s graduated=%s',
      async (progress, damm, phase, graduated) => {
        const { route } = build({
          pool: pool({
            migrationProgress: progress,
            quoteReserve: '999',
            migrationQuoteThreshold: '1',
            ...(damm ? { dammV2Pool: damm } : {}),
          }),
        });
        const r = await route.getMarketStatus(await intentOf(route));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.phase).toBe(phase);
        expect(r.value.graduated).toBe(graduated);
        expect(r.value.quoteReserve).toBe('999');
        expect(r.value.migrationQuoteThreshold).toBe('1');
        expect(Object.keys(r.value)).not.toContain('progressPercent');
      },
    );
    it('reaching the threshold is not graduation', async () => {
      const { route } = build({
        pool: pool({ migrationProgress: 0, quoteReserve: '10', migrationQuoteThreshold: '10' }),
      });
      const r = await route.getMarketStatus(await intentOf(route));
      expect(r.ok && r.value.graduated).toBe(false);
    });
    it('NOT_FOUND phase when the pool is absent', async () => {
      const { route } = build({ pool: null });
      const r = await route.getMarketStatus(await intentOf(route));
      expect(r.ok && r.value.phase).toBe('NOT_FOUND');
    });
  });

  describe('reconcileLaunch', () => {
    it('combines launch state and market status and is repeatable', async () => {
      const { route } = build({
        tx: ['FINALIZED'],
        pool: pool({ migrationProgress: 3, dammV2Pool: DAMM_POOL }),
      });
      const intent = await intentOf(route);
      const a = await route.reconcileLaunch(intent, ['a', 'b']);
      const b = await route.reconcileLaunch(intent, ['a', 'b']);
      expect(a).toEqual(b);
      expect(a.ok && a.value.launch.state).toBe('LIVE');
      expect(a.ok && a.value.market.graduated).toBe(true);
    });
    it('surfaces launch errors as typed results', async () => {
      const { route } = build({ tx: ['UNKNOWN'] });
      expect(code(await route.reconcileLaunch(await intentOf(route), ['a', 'b']))).toBe(
        'TRANSACTION_UNKNOWN',
      );
    });
  });
});
