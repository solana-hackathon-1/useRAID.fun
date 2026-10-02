'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { launchDiscovery } from '@/lib/meteora/view';
import { formatUnits } from '@/lib/meteora/amounts';
import styles from './meteora.module.css';
type Launch=Awaited<ReturnType<typeof launchDiscovery>>[number];
export function MeteoraDiscovery({launches}:{launches:Launch[]}) {
  const [stage,setStage]=useState('ALL'),[search,setSearch]=useState('');
  const filtered=launches.filter(l=>(stage==='ALL'||l.phase===stage)&&`${l.name} ${l.symbol} ${l.mint}`.toLowerCase().includes(search.toLowerCase()));
  return <section className={styles.card} aria-labelledby="launch-discovery"><div className={styles.row}><div><p className={styles.eyebrow}>Trading → fees → raids → attention</p><h2 id="launch-discovery">Community-powered launches</h2></div><Link className={styles.secondary} href="/launch">Launch token →</Link></div>
    <div className={styles.row}><label className={styles.field}>Launch stage<select value={stage} onChange={e=>setStage(e.target.value)}><option value="ALL">All launches</option><option value="BONDING">On the curve</option><option value="MIGRATING">Graduating</option><option value="GRADUATED">Graduated</option></select></label><label className={styles.field}>Find a token<input type="search" placeholder="Name, ticker or mint" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
    {!filtered.length&&<p className={styles.small}>{launches.length?'No launches match these filters.':'First launch starts here. Trading fees fund its own community rewards.'}</p>}
    <div className={styles.metrics}>{filtered.map(l=><Link className={styles.card} href={`/tokens/${l.mint}`} key={l.mint}><div className={styles.row}><img src={l.image} alt="" width={42} height={42} style={{borderRadius:12}}/><strong>{l.name} · ${l.symbol}</strong></div><p className={styles.eyebrow}>{l.network} · {l.phase.toLowerCase()}</p><progress className={styles.progress} max={1} value={l.snapshot?.progress || 0} aria-label={`${l.name} graduation progress`}/><p className={styles.small}>{l.snapshot?`${(l.snapshot.progress*100).toFixed(1)}% graduated · ${formatUnits(l.snapshot.campaignAllocatedUnits)} SOL to community`:'Pool metrics awaiting verification'}</p><span className={styles.small}>20% fees → community</span></Link>)}</div>
  </section>;
}
