import { describe, expect, it } from 'vitest';
import {
  METEORA_DBC_QUOTE_MINT,
  createMeteoraDbcLaunchRoute,
  type LaunchRoute,
} from '../src/launch-route';
import {
  RECORDED_ECONOMICS_DECISIONS,
  SOLANA_DEVNET_GENESIS_HASH,
  createMeteoraDbcLaunchRouteWithDecisions,
} from '../src/launch-route/meteora-dbc';
import {
  CONFIG_HASH,
  DEC,
  DEVNET_GENESIS,
  FEE_CLAIMER,
  FOUNDER,
  MAINNET_GENESIS,
  MINT,
  POOL,
  T0,
  addr,
  economics,
  mockClient,
  pool,
  request,
} from './helpers/launch-route-fixtures';

type State = Parameters<typeof mockClient>[0];
const build = (state: State = {}, over: Record<string, unknown> = {}, clock = { now: T0 }) => {
  const m = mockClient(state);
  const route = createMeteoraDbcLaunchRouteWithDecisions(
    {
      network: 'DEVNET',
      client: m.client,
      now: () => clock.now,
      economics: economics(over),
    },
    [DEC],
  );
  return { ...m, route, clock };
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'OK' : r.error!.code);
async function quoted(route: LaunchRoute) {
  const q = await route.quoteLaunch(request());
  if (!q.ok) throw new Error(`quote ${q.error.code}`);
  return q.value;
}
async function intentOf(route: LaunchRoute) {
  const p = await route.prepareLaunch(request(), await quoted(route));
  if (!p.ok) throw new Error(`prepare ${p.error.code}`);
  return p.value.intent;
}

describe('T026 review fix (a): verifyLaunch binds observed state to the pinned intent', () => {
  it('pins config hash and a digest of the unsigned transactions in the intent', async () => {
    const { route } = build();
    const intent = (await intentOf(route)) as unknown as Record<string, unknown>;
    expect(intent.configHash).toBe(CONFIG_HASH);
    expect(intent.transactionsDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    ['pool address', pool({ pool: addr(70) })],
    [
      'config hash (on-chain config differs from reviewed parameters)',
      pool({ configHash: 'f'.repeat(64) }),
    ],
    ['creator', pool({ creator: addr(71) })],
  ])('INCONSISTENT_STATE when the observed %s differs from the intent', async (_n, observed) => {
    const { route } = build({ tx: ['FINALIZED'], pool: observed });
    const intent = await intentOf(route);
    expect(code(await route.verifyLaunch(intent, ['a', 'b']))).toBe('INCONSISTENT_STATE');
    expect(code(await route.getMarketStatus(intent))).toBe('INCONSISTENT_STATE');
  });
  it.each([
    ['mint', { mint: addr(72) }],
    ['pool', { pool: addr(73) }],
    ['program', { programId: addr(74) }],
    ['signer', { signer: addr(75) }],
    ['signature echo', { signature: 'someone-elses' }],
  ])('a finalized signature for a different %s never yields LIVE', async (_n, binding) => {
    const { route } = build({ tx: ['FINALIZED'], txBinding: binding as never });
    const intent = await intentOf(route);
    expect(code(await route.verifyLaunch(intent, ['a', 'b']))).toBe('INCONSISTENT_STATE');
  });
  it('LIVE facts come from the observation, including pool, creator and config hash', async () => {
    const { route } = build({ tx: ['FINALIZED'] });
    const intent = await intentOf(route);
    const r = await route.verifyLaunch(intent, ['a', 'b']);
    expect(r.ok && r.value.state).toBe('LIVE');
    if (!r.ok) return;
    expect(r.value.facts).toMatchObject({ pool: POOL, mint: MINT, feeClaimer: FEE_CLAIMER });
    expect(r.value.facts as unknown).toMatchObject({ creator: FOUNDER, configHash: CONFIG_HASH });
  });
  it('rejects a malformed pinned intent (bad pool, hash or digest) as PROTOCOL_MISMATCH without provider calls', async () => {
    const { route, calls } = build({ tx: ['FINALIZED'] });
    const good = (await intentOf(route)) as unknown as Record<string, unknown>;
    for (const over of [
      { pool: 'nope' },
      { parameterHash: 'x' },
      { configHash: 'x' },
      { transactionsDigest: 'x' },
      { founderWallet: 'x' },
    ]) {
      const r = await route.verifyLaunch({ ...good, ...over } as never, ['a', 'b']);
      expect(code(r)).toBe('PROTOCOL_MISMATCH');
    }
    expect(calls.tx + calls.pool).toBe(0);
  });
});

describe('T026 review fix (b): quote is authenticated and unsigned transactions are bound', () => {
  it('prepare re-reads the quote from the provider and never trusts caller expiresAt', async () => {
    const { route, clock, calls } = build();
    const q = await quoted(route);
    clock.now = new Date('2026-11-07T12:01:00.000Z');
    const forged = { ...q, expiresAt: '2999-01-01T00:00:00.000Z' };
    expect(code(await route.prepareLaunch(request(), forged))).toBe('INCONSISTENT_STATE');
    expect(code(await route.prepareLaunch(request(), q))).toBe('QUOTE_EXPIRED');
    expect(calls.build).toBe(0);
  });
  it.each([
    ['amounts', { amounts: { fee: '1' } }],
    ['quote id', { quoteId: 'q-other' }],
    ['parameter hash', { parameterHash: 'e'.repeat(64) }],
  ])('refuses a caller quote with altered %s', async (_n, alter) => {
    const { route, calls } = build();
    const q = await quoted(route);
    expect(code(await route.prepareLaunch(request(), { ...q, ...alter } as never))).toBe(
      'INCONSISTENT_STATE',
    );
    expect(calls.build).toBe(0);
  });
  it('refuses a quote the provider does not know', async () => {
    const { route, calls } = build({ providerQuote: () => null });
    expect(code(await route.prepareLaunch(request(), await quoted(route)))).toBe(
      'INCONSISTENT_STATE',
    );
    expect(calls.build).toBe(0);
  });
  it('uses the provider record for expiry: a shortened provider expiry wins over the caller copy', async () => {
    const { route, clock } = build({
      providerQuote: (q) => ({ ...q, expiresAt: '2026-11-07T12:00:00.000Z' }),
    });
    const q = await quoted(route);
    clock.now = T0;
    expect(code(await route.prepareLaunch(request(), q))).toBe('INCONSISTENT_STATE');
  });
  it('maps a getQuote provider failure to PROVIDER_UNAVAILABLE', async () => {
    const { route } = build({ fail: { getQuote: new Error('down') } });
    expect(code(await route.prepareLaunch(request(), await quoted(route)))).toBe(
      'PROVIDER_UNAVAILABLE',
    );
  });
  it.each([
    ['decimal', { fee: '1.5' }],
    ['negative', { fee: '-1' }],
    ['number', { fee: 7 }],
    ['leading zero', { fee: '007' }],
    ['too long', { fee: '1'.repeat(80) }],
    ['bad key', { 'fee total': '1' }],
  ])('rejects %s quote amounts', async (_n, quoteAmounts) => {
    const { route } = build({ quoteAmounts: quoteAmounts as never });
    expect(code(await route.quoteLaunch(request()))).toBe('INCONSISTENT_STATE');
  });
  it.each([
    ['parameter hash', { parameterHash: 'd'.repeat(64) }],
    ['quote id', { quoteId: 'other' }],
    ['amounts', { amounts: { fee: '8' } }],
  ])('refuses an unsigned build bound to a different %s', async (_n, built) => {
    const { route } = build({ built });
    const q = await quoted(route);
    expect(code(await route.prepareLaunch(request(), q))).toBe('INCONSISTENT_STATE');
  });
  it.each([
    ['not base64', [{ serializedBase64: '!!notbase64!!', description: 'x' }]],
    ['empty', [{ serializedBase64: '', description: 'x' }]],
    ['too many', Array.from({ length: 9 }, () => ({ serializedBase64: 'AAAA', description: 'x' }))],
    ['no description', [{ serializedBase64: 'AAAA' }]],
  ])('refuses malformed unsigned transactions (%s)', async (_n, transactions) => {
    const { route } = build({ built: { transactions } });
    expect(code(await route.prepareLaunch(request(), await quoted(route)))).toBe(
      'INCONSISTENT_STATE',
    );
  });
  it('digest changes when a transaction changes', async () => {
    const a = build();
    const b = build({ built: { transactions: [{ serializedBase64: 'BBBB', description: 'x' }] } });
    const ia = (await intentOf(a.route)) as unknown as { transactionsDigest: string };
    const ib = (await intentOf(b.route)) as unknown as { transactionsDigest: string };
    expect(ia.transactionsDigest).not.toBe(ib.transactionsDigest);
  });
});

describe('T026 review fix (c): economics need a recorded decision; fixed rules at every depth', () => {
  it('the shipped recorded-decision registry is empty, so no host can configure the route today', async () => {
    expect(RECORDED_ECONOMICS_DECISIONS).toEqual([]);
    expect(Object.isFrozen(RECORDED_ECONOMICS_DECISIONS)).toBe(true);
    const m = mockClient();
    for (const decisionRef of [DEC, 'DEC-2026-11-07-04', 'x', '', 'test-only-decision-reference']) {
      const route = createMeteoraDbcLaunchRoute({
        network: 'DEVNET',
        client: m.client,
        now: () => T0,
        economics: economics({ decisionRef }) as never,
      });
      expect(route.capabilities().configured).toBe(false);
      expect(route.capabilities().openDecisions).toEqual(['O02', 'O08']);
      const r = await route.validateLaunch(request());
      expect(code(r)).toBe('NOT_CONFIGURED');
      expect(code(await route.quoteLaunch(request()))).toBe('NOT_CONFIGURED');
    }
    expect(m.calls.quote + m.calls.genesis).toBe(0);
  });
  it('the public entry point does not export the registry seam', async () => {
    const entry = await import('../src/launch-route');
    expect(Object.keys(entry)).not.toContain('createMeteoraDbcLaunchRouteWithDecisions');
    expect(Object.keys(entry)).not.toContain('RECORDED_ECONOMICS_DECISIONS');
  });
  it('a decision outside the recorded set, or mutated after construction, is NOT_CONFIGURED', async () => {
    const m = mockClient();
    const e = economics();
    const route = createMeteoraDbcLaunchRouteWithDecisions(
      { network: 'DEVNET', client: m.client, now: () => T0, economics: e as never },
      [DEC],
    );
    expect(code(await route.validateLaunch(request()))).toBe('OK');
    e.decisionRef = 'DEC-2030-01-01-02';
    expect(code(await route.validateLaunch(request()))).toBe('NOT_CONFIGURED');
    expect(route.capabilities().configured).toBe(false);
  });
  it.each([
    ['unknown top-level key', { placeholderA: 'x' }],
    ['custom curve under an unlisted name', { bespokeCurve: [{ sqrtPrice: '1', liquidity: '1' }] }],
    ['custom curve program under an unlisted name', { pricingEngine: addr(5) }],
    ['deep custom curve', { migrationFee: { feePercentage: '1', bonding: { points: [] } } }],
    ['unknown key beside a known one', { migrationFee: { feePercentage: '1', surprise: 'x' } }],
    ['own __proto__ key', JSON.parse('{"__proto__":{"polluted":true}}')],
    ['alias spelling of a known key', { pool_creation_fee: 'x' }],
    ['quote mint key (the route pins it)', { quoteMint: METEORA_DBC_QUOTE_MINT }],
    ['quote asset key', { quote_asset: addr(99) }],
    ['object where a scalar is expected', { tokenDecimal: { value: 6 } }],
    ['array where a scalar is expected', { tokenDecimal: [6] }],
    ['scalar where an object is expected', { migrationFee: '1' }],
    ['migration option DAMM v1', { migrationOption: 0 }],
    ['migration option by name other than DAMM v2', { migrationOption: 'DAMM_V1' }],
    ['curve point with an extra key', { curve: [{ sqrtPrice: '1', liquidity: '1', extra: '1' }] }],
    ['curve that is not a list', { curve: { sqrtPrice: '1', liquidity: '1' } }],
    [
      'curve beyond the on-chain capacity',
      { curve: Array.from({ length: 21 }, () => ({ sqrtPrice: '1', liquidity: '1' })) },
    ],
  ])(
    'rejects %s as UNSUPPORTED_PARAMETERS (allow-list, fail closed)',
    async (_n, configParameters) => {
      const { route } = build({}, { configParameters });
      expect(code(await route.validateLaunch(request()))).toBe('UNSUPPORTED_PARAMETERS');
    },
  );
  it('accepts only documented ConfigParameters field names, with scalar values', async () => {
    for (const configParameters of [
      { migrationOption: 1 },
      { migrationOption: 'DAMM_V2' },
      {
        migrationQuoteThreshold: '100',
        creatorTradingFeePercentage: 0,
        enableFirstSwapWithMinFee: false,
      },
      { tokenSupply: { preMigrationTokenSupply: '1', postMigrationTokenSupply: '1' } },
      { curve: [{ sqrtPrice: '1', liquidity: '1' }] },
      { curve: Array.from({ length: 20 }, () => ({ sqrtPrice: '1', liquidity: '1' })) },
    ]) {
      const { route } = build({}, { configParameters });
      expect(code(await route.validateLaunch(request()))).toBe('OK');
    }
  });
  it('bounds configParameters depth and size', async () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    const { route } = build({}, { configParameters: deep });
    expect(code(await route.validateLaunch(request()))).toBe('UNSUPPORTED_PARAMETERS');
  });
});

describe('T026 review fix (d): the client cluster must be devnet before any call', () => {
  it('pins the devnet genesis hash', () => {
    expect(SOLANA_DEVNET_GENESIS_HASH).toBe(DEVNET_GENESIS);
  });
  it.each([
    ['mainnet', MAINNET_GENESIS],
    ['unknown', addr(1)],
    ['missing', undefined],
    ['non-string', 42],
  ])(
    'NETWORK_REFUSED on a %s genesis for every provider-touching operation, with no further call',
    async (_n, genesis) => {
      const { route, calls } = build({ genesis, tx: ['FINALIZED'] });
      const q = await route.quoteLaunch(request());
      expect(code(q)).toBe('NETWORK_REFUSED');
      const goodQuote = await build().route.quoteLaunch(request());
      if (!goodQuote.ok) throw new Error('q');
      expect(code(await route.prepareLaunch(request(), goodQuote.value))).toBe('NETWORK_REFUSED');
      const intent = await intentOf(build().route);
      expect(code(await route.verifyLaunch(intent, ['a', 'b']))).toBe('NETWORK_REFUSED');
      expect(code(await route.getMarketStatus(intent))).toBe('NETWORK_REFUSED');
      expect(code(await route.reconcileLaunch(intent, ['a', 'b']))).toBe('NETWORK_REFUSED');
      expect(calls.quote + calls.getQuote + calls.build + calls.tx + calls.pool).toBe(0);
      expect(calls.genesis).toBeGreaterThan(0);
    },
  );
  it('asserts genesis before the provider on every call, not once', async () => {
    const { route, calls } = build({ tx: ['FINALIZED'] });
    const intent = await intentOf(route);
    const before = calls.genesis;
    await route.getMarketStatus(intent);
    await route.getMarketStatus(intent);
    expect(calls.genesis).toBe(before + 2);
  });
  it('a genesis lookup failure is PROVIDER_UNAVAILABLE and nothing else is called', async () => {
    const { route, calls } = build({ fail: { genesis: new Error('rpc down') } });
    expect(code(await route.quoteLaunch(request()))).toBe('PROVIDER_UNAVAILABLE');
    expect(calls.quote).toBe(0);
  });
  it('validateLaunch stays offline', async () => {
    const { route, calls } = build({ genesis: MAINNET_GENESIS });
    expect(code(await route.validateLaunch(request()))).toBe('OK');
    expect(calls.genesis).toBe(0);
  });
});
