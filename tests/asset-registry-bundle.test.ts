import { describe, expect, it } from 'vitest';
import { assetKey } from '../src/contracts';
import {
  U64_MAX,
  createAssetRegistry,
  creditedByAsset,
  evaluateRewardFunding,
} from '../src/asset-registry';
import {
  MINT_ONE,
  MINT_TWO,
  NETWORK_B,
  baseInput,
  mulberry32,
  native,
  policy,
  randomBigint,
  token,
  codeOf,
} from './helpers/asset-fixtures';

const registry = createAssetRegistry(baseInput());
const usdcOne = token(MINT_ONE);
const usdcTwo = token(MINT_TWO);
const stateOf = (result: ReturnType<typeof evaluateRewardFunding>, id: object) =>
  result.assets.find((entry) => entry.assetKey === assetKey(id as never))?.state;

describe('T029 a reward is fully funded only when every promised leg is verified (AC28, 16.4)', () => {
  const legs = [
    { assetId: usdcOne, amount: '300000000' },
    { assetId: native(), amount: '1000000000' },
  ];
  it('is not funded when only one of two promised assets is deposited', () => {
    const result = evaluateRewardFunding(registry, legs, [
      { operationId: 'op-1', assetId: usdcOne, amount: '300000000', verified: true },
    ]);
    expect(result.fullyFunded).toBe(false);
    expect(stateOf(result, usdcOne)).toBe('VERIFIED');
    expect(stateOf(result, native())).toBe('REQUIRED');
  });
  it('is funded once both legs are verified', () => {
    const result = evaluateRewardFunding(registry, legs, [
      { operationId: 'op-1', assetId: usdcOne, amount: '300000000', verified: true },
      { operationId: 'op-2', assetId: native(), amount: '1000000000', verified: true },
    ]);
    expect(result.fullyFunded).toBe(true);
    expect(result.assets.map((entry) => entry.state)).toEqual(['VERIFIED', 'VERIFIED']);
  });
  it('reports a shortfall for an under-deposited leg and counts nothing unverified', () => {
    const result = evaluateRewardFunding(registry, legs, [
      { operationId: 'op-1', assetId: usdcOne, amount: '299999999', verified: true },
      { operationId: 'op-2', assetId: native(), amount: '1000000000', verified: false },
    ]);
    expect(result.fullyFunded).toBe(false);
    expect(stateOf(result, usdcOne)).toBe('SHORTFALL');
    expect(stateOf(result, native())).toBe('PENDING');
    const sol = result.assets.find((entry) => entry.assetKey === assetKey(native()));
    expect(sol?.verified).toBe('0');
    expect(sol?.pending).toBe('1000000000');
  });
  it('does not accept a deposit of a same-ticker different mint or the same mint on another network', () => {
    const result = evaluateRewardFunding(
      registry,
      [legs[0]],
      [
        { operationId: 'op-1', assetId: usdcTwo, amount: '300000000', verified: true },
        {
          operationId: 'op-2',
          assetId: token(MINT_ONE, NETWORK_B),
          amount: '300000000',
          verified: true,
        },
      ],
    );
    expect(result.fullyFunded).toBe(false);
    expect(stateOf(result, usdcOne)).toBe('REQUIRED');
  });
  it('ignores unrelated surplus assets and allows surplus of a promised asset', () => {
    const result = evaluateRewardFunding(
      registry,
      [legs[0]],
      [
        { operationId: 'op-1', assetId: usdcOne, amount: '400000000', verified: true },
        { operationId: 'op-2', assetId: native(), amount: '5', verified: true },
      ],
    );
    expect(result.fullyFunded).toBe(true);
    expect(result.assets).toHaveLength(1);
  });
  it('blocks a leg whose asset is not supported by the registry', () => {
    const result = evaluateRewardFunding(
      registry,
      [{ assetId: token(MINT_ONE, NETWORK_B), amount: '1' }],
      [{ operationId: 'op-1', assetId: token(MINT_ONE, NETWORK_B), amount: '1', verified: true }],
    );
    expect(result.fullyFunded).toBe(false);
    expect(result.assets[0].state).toBe('BLOCKED');
  });
  it('never calls an empty bundle funded', () => {
    expect(evaluateRewardFunding(registry, [], []).fullyFunded).toBe(false);
  });
  it('rejects zero, malformed and noncanonical leg amounts', () => {
    const obs: never[] = [];
    expect(
      codeOf(() => evaluateRewardFunding(registry, [{ assetId: usdcOne, amount: '0' }], obs)),
    ).toBe('INVALID_AMOUNT');
    expect(
      codeOf(() => evaluateRewardFunding(registry, [{ assetId: usdcOne, amount: '1.5' }], obs)),
    ).toBe('INVALID_AMOUNT');
    expect(
      codeOf(() =>
        evaluateRewardFunding(registry, [{ assetId: usdcOne, amount: 5 as never }], obs),
      ),
    ).toBe('INVALID_AMOUNT');
    expect(
      codeOf(() =>
        evaluateRewardFunding(
          registry,
          [{ assetId: { symbol: 'USDC' } as never, amount: '1' }],
          obs,
        ),
      ),
    ).toBe('INVALID_ASSET_ID');
  });
  it('aggregates two legs of one asset and guards the sum against overflow', () => {
    const two = [
      { assetId: usdcOne, amount: '100' },
      { assetId: usdcOne, amount: '50' },
    ];
    const result = evaluateRewardFunding(registry, two, [
      { operationId: 'op-1', assetId: usdcOne, amount: '149', verified: true },
    ]);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].required).toBe('150');
    expect(result.assets[0].state).toBe('SHORTFALL');
    expect(
      codeOf(() =>
        evaluateRewardFunding(
          registry,
          [
            { assetId: usdcOne, amount: U64_MAX.toString() },
            { assetId: usdcOne, amount: '1' },
          ],
          [],
        ),
      ),
    ).toBe('AMOUNT_OVERFLOW');
  });
});

describe('T029 policy version and duplicate delivery cannot duplicate spendable balance (AC30, I05)', () => {
  it('counts a repeated operation once even when tagged with different policy versions', () => {
    const credited = creditedByAsset(registry, [
      {
        operationId: 'op-1',
        assetId: usdcOne,
        amount: '500',
        verified: true,
        registryVersion: 'fixture-v1',
      },
      {
        operationId: 'op-1',
        assetId: usdcOne,
        amount: '500',
        verified: true,
        registryVersion: 'fixture-v2',
      },
      { operationId: 'op-1', assetId: usdcOne, amount: '500', verified: true },
    ]);
    expect(credited.get(assetKey(usdcOne))).toEqual({ verified: 500n, pending: 0n });
    expect(credited.size).toBe(1);
  });
  it('sums distinct operations under one key regardless of policy version', () => {
    const next = registry.withPolicy(policy(usdcOne, 'fixture-v2', { observedSlot: '200' }));
    const credited = creditedByAsset(next, [
      {
        operationId: 'op-1',
        assetId: usdcOne,
        amount: '500',
        verified: true,
        registryVersion: 'fixture-v1',
      },
      {
        operationId: 'op-2',
        assetId: usdcOne,
        amount: '250',
        verified: true,
        registryVersion: 'fixture-v2',
      },
    ]);
    expect(credited.get(assetKey(usdcOne))).toEqual({ verified: 750n, pending: 0n });
    expect([...credited.keys()]).toEqual([assetKey(usdcOne)]);
  });
  it('treats a late verified delivery as the same operation progressing, never as extra funds', () => {
    const credited = creditedByAsset(registry, [
      { operationId: 'op-1', assetId: usdcOne, amount: '500', verified: false },
      { operationId: 'op-1', assetId: usdcOne, amount: '500', verified: true },
      { operationId: 'op-1', assetId: usdcOne, amount: '500', verified: false },
    ]);
    expect(credited.get(assetKey(usdcOne))).toEqual({ verified: 500n, pending: 0n });
  });
  it('rejects a conflicting redelivery of the same operation', () => {
    expect(
      codeOf(() =>
        creditedByAsset(registry, [
          { operationId: 'op-1', assetId: usdcOne, amount: '500', verified: true },
          { operationId: 'op-1', assetId: usdcOne, amount: '501', verified: true },
        ]),
      ),
    ).toBe('CONFLICTING_OBSERVATION');
    expect(
      codeOf(() =>
        creditedByAsset(registry, [
          { operationId: 'op-1', assetId: usdcOne, amount: '500', verified: true },
          { operationId: 'op-1', assetId: usdcTwo, amount: '500', verified: true },
        ]),
      ),
    ).toBe('CONFLICTING_OBSERVATION');
  });
  it('rejects malformed observations and overflowing totals', () => {
    expect(
      codeOf(() =>
        creditedByAsset(registry, [
          { operationId: '', assetId: usdcOne, amount: '1', verified: true },
        ]),
      ),
    ).toBe('INVALID_CONFIGURATION');
    expect(
      codeOf(() =>
        creditedByAsset(registry, [
          { operationId: 'a', assetId: usdcOne, amount: '1', verified: 'yes' as never },
        ]),
      ),
    ).toBe('INVALID_CONFIGURATION');
    expect(
      codeOf(() =>
        creditedByAsset(registry, [
          { operationId: 'a', assetId: usdcOne, amount: U64_MAX.toString(), verified: true },
          { operationId: 'b', assetId: usdcOne, amount: '1', verified: true },
        ]),
      ),
    ).toBe('AMOUNT_OVERFLOW');
  });
  it('ignores observations for assets the registry does not know instead of crediting them', () => {
    const credited = creditedByAsset(registry, [
      { operationId: 'a', assetId: token(MINT_ONE, NETWORK_B), amount: '1', verified: true },
    ]);
    expect(credited.size).toBe(0);
  });
  it('credits exactly the verified deposits for random duplicated streams (property)', () => {
    const random = mulberry32(28);
    for (let round = 0; round < 200; round++) {
      const ops = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) => ({
        operationId: `op-${round}-${index}`,
        amount: randomBigint(random, 1_000_000n),
        verified: random() < 0.7,
      }));
      const stream = ops.flatMap((op) =>
        Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
          operationId: op.operationId,
          assetId: usdcOne,
          amount: op.amount.toString(),
          verified: op.verified,
          registryVersion: random() < 0.5 ? 'fixture-v1' : 'fixture-v2',
        })),
      );
      stream.sort(() => random() - 0.5);
      const credited = creditedByAsset(registry, stream).get(assetKey(usdcOne));
      const verified = ops.filter((op) => op.verified).reduce((sum, op) => sum + op.amount, 0n);
      const pending = ops.filter((op) => !op.verified).reduce((sum, op) => sum + op.amount, 0n);
      expect(credited?.verified ?? 0n).toBe(verified);
      expect(credited?.pending ?? 0n).toBe(pending);
    }
  });
});
