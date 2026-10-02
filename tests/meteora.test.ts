import { describe, it, expect } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { assertMeteoraNetwork } from '../src/lib/meteora/config';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { getMigrationThresholdPrice, getBaseTokenForSwap, getMigrationBaseToken, validateConfigParameters, MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { buildLaunchCurve } from '../src/lib/meteora/template';
import { parseUnits,formatUnits,splitFees,assertSupply,TOTAL_SUPPLY_UNITS,RESERVE_UNITS } from '../src/lib/meteora/amounts';
import { verifyReviewedTransaction,messageHash } from '../src/lib/meteora/transactions';
import { splitImpressionFunding } from '../src/lib/raid-allocation';
import { metadataImmutable } from '../src/lib/meteora/state';
describe('Meteora canonical economics and signed message boundary',()=>{
  for(const network of ['devnet','mainnet'] as const)it(`conserves fixed supply after ${network} SDK rounding`,()=>{
    const cfg=buildLaunchCurve(network);const key=Keypair.generate().publicKey;
    expect(()=>validateConfigParameters({...cfg,leftoverReceiver:key})).not.toThrow();
    const migrationPrice=getMigrationThresholdPrice(cfg.migrationQuoteThreshold,cfg.sqrtStartPrice,cfg.curve);
    const sale=BigInt(getBaseTokenForSwap(cfg.sqrtStartPrice,migrationPrice,cfg.curve).toString());
    const lp=BigInt(getMigrationBaseToken(cfg.migrationQuoteThreshold,migrationPrice,MigrationOption.MET_DAMM_V2).toString());
    const reserve=TOTAL_SUPPLY_UNITS-sale-lp;
    assertSupply([sale,lp,reserve]);expect(reserve>=RESERVE_UNITS).toBe(true);expect(reserve-RESERVE_UNITS<100_000_000n).toBe(true);
    expect(cfg.partnerPermanentLockedLiquidityPercentage).toBe(100);expect(cfg.creatorTradingFeePercentage).toBe(0);
    expect(cfg.migratedPoolFee?.poolFeeBps).toBe(100);expect(cfg.migratedPoolFee?.collectFeeMode).toBe(0);expect(cfg.migratedPoolFee?.dynamicFee).toBe(0);
  });
  it('keeps tiny and large fee splits integer and conservative',()=>{
    for(const units of [0n,1n,4n,5n,99n,100n,9999999999999999n]){const s=splitFees(units);expect(s.creator+s.campaign+s.protocol).toBe(units);expect(s.campaign).toBe(units*20n/100n);}
    expect(parseUnits('0.000000001',9)).toBe(1n);expect(formatUnits(parseUnits('1000000000',6),6)).toBe('1000000000');
    for(const value of ['1e9','-1','NaN','0','1.0000000001','18446744074'])expect(()=>parseUnits(value,9)).toThrow();
  });
  it('accepts exact reviewed signatures, rejects modified payer, recipient, amount and blockhash',()=>{
    const payer=Keypair.generate(),receiver=Keypair.generate().publicKey;
    const build=()=>new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:receiver,lamports:1n}));
    const tx=build();tx.sign(payer);const expected={payer:payer.publicKey.toBase58(),messageHash:messageHash(tx)};
    expect(verifyReviewedTransaction(tx.serialize().toString('base64'),expected).signature).toBeTruthy();
    const changed=Transaction.from(tx.serialize());changed.instructions[0]=SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:2n});changed.sign(payer);
    expect(()=>verifyReviewedTransaction(changed.serialize().toString('base64'),expected)).toThrow('differs from review');
    expect(()=>verifyReviewedTransaction(tx.serialize().toString('base64'),{...expected,payer:receiver.toBase58()})).toThrow();
    const unsigned=build();expect(()=>verifyReviewedTransaction(unsigned.serialize({requireAllSignatures:false}).toString('base64'),{payer:expected.payer,messageHash:messageHash(unsigned)})).toThrow('signatures');
  });
  it('returns zero-view budgets and caps over-target payouts independently by asset',()=>{
    const users=[{xId:'a',walletAddress:'a',views:400},{xId:'b',walletAddress:'b',views:200}];
    for(const budget of [10_000_000n,RESERVE_UNITS]){const r=splitImpressionFunding(budget,1000,users);expect(r.refund).toBe(budget*4n/10n);expect(r.rewards.reduce((a,p)=>a+p.lamports,0n)+r.refund).toBe(budget);const zero=splitImpressionFunding(budget,1000,users.map(u=>({...u,views:0})));expect(zero.rewards).toEqual([]);expect(zero.refund).toBe(budget);}
    const over=splitImpressionFunding(11n,1000,users.map(u=>({...u,views:u.views*10})));expect(over.rewards.reduce((a,p)=>a+p.lamports,0n)+over.refund).toBe(11n);
  });
  it('fails closed on malformed or mutable metadata',()=>{
    const data=Buffer.alloc(65+4*3+2+1+2);data[data.length-1]=0;expect(metadataImmutable(data)).toBe(true);data[data.length-1]=1;expect(metadataImmutable(data)).toBe(false);expect(metadataImmutable(Buffer.alloc(2))).toBe(false);
  });
});

describe('Meteora RPC network validation', () => {
  const rpc = (hash: string) => ({ getGenesisHash: async () => hash }) as Connection;
  it('accepts devnet full genesis hash', async () => {
    await expect(assertMeteoraNetwork(rpc('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'), 'devnet')).resolves.toBeUndefined();
  });
  it('rejects mainnet RPC in devnet mode', async () => {
    await expect(assertMeteoraNetwork(rpc('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'), 'devnet')).rejects.toThrow('Solana RPC must point to devnet.');
  });
});
