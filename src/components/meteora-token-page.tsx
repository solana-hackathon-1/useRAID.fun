import Link from 'next/link';
import { ShieldCheck, ArrowUpRight, Radio, LockKeyhole } from 'lucide-react';
import type { MeteoraTokenView } from '@/lib/meteora/view';
import { formatUnits } from '@/lib/meteora/amounts';
import { AutoRefresh } from './refresh';
import { MeteoraTrade } from './meteora-trade';
import styles from './meteora.module.css';
const sol=(v?:string)=>v===undefined?'—':formatUnits(v);
export function MeteoraTokenPage({view,tradingEnabled}:{view:MeteoraTokenView;tradingEnabled:boolean}) {
  const s=view.snapshot, stale=!view.observedAt || Date.now()-Date.parse(view.observedAt)>120000, phase=s?.phase || view.migrationStatus;
  return <div className={styles.page}>
    <AutoRefresh/><Link className={styles.small} href="/">← Discover</Link>
    <header className={styles.header}><div className={styles.row}><img src={view.image} alt={`${view.name} logo`} width={80} height={80} style={{borderRadius:20,objectFit:'cover'}}/><div><p className={styles.eyebrow}>{view.network} · {phase.toLowerCase()} · SOL pair</p><h1>{view.name} <small>${view.symbol}</small></h1><p>{view.description || 'Trading activity powers this community.'}</p></div></div>
      <a className={styles.secondary} href={`https://x.com/intent/post?text=${encodeURIComponent(`${view.name} is live on useRAID. 20% of distributable fees fund community rewards.\n${process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://useRAID.fun'}/tokens/${view.mint}\nCA: ${view.mint}`)}`} target="_blank" rel="noreferrer">Share launch <ArrowUpRight size={16}/></a></header>
    {view.network==='devnet'&&<div className={styles.notice}>Devnet pilot · Test SOL and test tokens. Network clearly shown in wallet.</div>}
    {view.error&&<p className={styles.error} role="status">{view.error}</p>}
    <div className={styles.grid}><div>
      <section className={styles.card}><div className={styles.row}><h2>Trading funds attention.</h2><span className={styles.small}>{stale?'Pool data delayed':`Verified ${new Date(view.observedAt!).toLocaleTimeString('en')}`}</span></div>
        <div className={styles.metrics}><div className={styles.stat}><span>Token price</span><strong>{s?`${Number(s.priceSol).toPrecision(5)} SOL`:'—'}</strong></div><div className={styles.stat}><span>Graduation target</span><strong>{sol(s?.graduationUnits)} SOL</strong></div><div className={styles.stat}><span>Volume / holders</span><strong>Unavailable</strong></div></div>
        <div className={styles.row}><span>{phase==='GRADUATED'?'Graduated to DAMM v2':phase==='MIGRATING'?'Graduation in progress':'Bonding curve progress'}</span><strong>{s?`${(s.progress*100).toFixed(1)}%`:'—'}</strong></div><progress className={styles.progress} max={1} value={s?.progress || 0} aria-label="Graduation progress"/>
        <p className={styles.small}>{sol(s?.quoteReserveUnits)} SOL raised toward graduation. {phase==='MIGRATING'?'Trading resumes after destination pool is verified.':'Native trading through Meteora.'}</p>
        <div className={styles.chips}>{s?.authoritiesVerified&&<span><ShieldCheck size={14}/> Fixed supply · No mint or freeze authority</span>}{s?.liquidityLockedVerified&&<span><LockKeyhole size={14}/> Liquidity permanently locked</span>}{s?.authoritiesVerified&&<span>Immutable metadata</span>}</div>
      </section>
      <section className={styles.card}><p className={styles.eyebrow}>Community rewards</p><h2>20% keeps the raid going.</h2>
        <div className={styles.metrics}><div className={styles.stat}><span>Available now</span><strong>{sol(view.balances.sol.available)} SOL</strong></div><div className={styles.stat}><span>Reserved for campaigns</span><strong>{sol(view.balances.sol.reserved)} SOL</strong></div><div className={styles.stat}><span>{s?.reserveWithdrawn?'Token rewards available':'Unlocks after graduation'}</span><strong>{s?.reserveWithdrawn?formatUnits(view.balances.token.available,6):'50,000,000'} ${view.symbol}</strong></div></div>
        <p className={styles.small}>Token reserve is configured at 50M. Only finalized withdrawals become spendable. SOL and token rewards stay separate.</p>
        <div className={styles.metrics}><div className={styles.stat}><span>Creator allocated / claimed</span><strong>{sol(s?.creatorAllocatedUnits)} / {sol(s?.creatorClaimedUnits)} SOL</strong></div><div className={styles.stat}><span>Community allocated / claimed</span><strong>{sol(s?.campaignAllocatedUnits)} / {sol(s?.campaignClaimedUnits)} SOL</strong></div><div className={styles.stat}><span>Raider rewards paid</span><strong>{sol(view.balances.sol.paid)} SOL</strong><small>{formatUnits(view.balances.token.paid,6)} ${view.symbol}</small></div></div>
        <p className={styles.small}>Creator 80% · Community 20% · useRAID 0%. Split applies to distributable fees from launch-owned liquidity, after Meteora protocol fees.</p>
        {view.isCreator&&<Link className={styles.button} href={`/launch/${view.id}/campaign`}>Add X posts & start raid →</Link>}
      </section>
      <section className={styles.card}><div className={styles.row}><h2><Radio size={20}/> Community attention</h2><span className={styles.small}>Campaign activity</span></div><div className={styles.metrics}><div className={styles.stat}><span>Qualified posts</span><strong>{view.attention.qualifiedPosts.toLocaleString()}</strong></div><div className={styles.stat}><span>Contributing raiders</span><strong>{view.attention.raiders.toLocaleString()}</strong></div><div className={styles.stat}><span>Observed impressions</span><strong>{view.attention.impressions.total.toLocaleString()}</strong><small>{view.attention.impressions.missing?`${view.attention.impressions.missing} posts missing metrics`:'Available qualified post metrics'}</small></div></div>
        <h3>Raids</h3>{view.raids.length?view.raids.map(r=><div className={styles.row} key={r.id}><Link href={r.status==='DRAFT'?`/launch/${view.id}/campaign`:`/raids/${r.id}`}>{r.title} →</Link><span className={styles.small}>{r.status.toLowerCase()}</span></div>):<p>RAID ready. Creator can start once campaign fees accumulate.</p>}
      </section>
      <details className={styles.card}><summary>Immutable launch configuration</summary><p className={styles.small}>1B fixed supply · 6 decimals · 1% trading fee · Dynamic fees off · 20% supply target in migration liquidity · 5% campaign reserve · 100% launch LP permanently locked.</p><p className={styles.small}>Supply assigned to liquidity and ownership of LP positions are distinct allocations. SDK rounds exact base units; snapshots show actual chain values.</p>
        <dl><dt>Mint</dt><dd className={styles.address}>{view.mint}</dd><dt>Creator recipient</dt><dd className={styles.address}>{(view.configuration as {creatorAddress:string}).creatorAddress}</dd><dt>Campaign recipient</dt><dd className={styles.address}>{view.feeAddress}</dd><dt>Fee-sharing vault</dt><dd className={styles.address}>{view.feeVaultAddress}</dd></dl>
        {s&&<p className={styles.small}>Curve sale: {formatUnits(s.actualCurveSaleUnits,6)} tokens · Migration liquidity: {formatUnits(s.actualMigrationBaseUnits,6)} tokens · Burned: {formatUnits(s.burnedUnits,6)} tokens.</p>}<pre className={styles.address}>{JSON.stringify(view.configuration,null,2)}</pre></details>
    </div><aside><MeteoraTrade view={view} enabled={tradingEnabled}/></aside></div>
  </div>;
}
