'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeteoraTokenView } from '@/lib/meteora/view';
import { formatUnits } from '@/lib/meteora/amounts';
import { useMeteoraWallet, meteoraRequest, signMeteoraTransaction } from './meteora-launch-wizard';
import styles from './meteora.module.css';
type Quote={id:string;transaction:string;side:'BUY'|'SELL';amountUnits:string;outputUnits:string;minimumOutputUnits:string;feeUnits:string;priceImpactPercent:string;expiresAt:string;solBalanceUnits:string;tokenBalanceUnits:string};
type Receipt={id:string;status:string;signature:string|null;error:string|null};
export function MeteoraTrade({view,enabled}:{view:MeteoraTokenView;enabled:boolean}) {
  const router=useRouter(), wallet=useMeteoraWallet(view.network as 'devnet'|'mainnet',view.walletAddress);
  const [side,setSide]=useState<'BUY'|'SELL'>('BUY'),[amount,setAmount]=useState(''),[slippage,setSlippage]=useState('1'),[quote,setQuote]=useState<Quote|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<Receipt|null>(null),[now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[]);
  useEffect(()=>{setQuote(null);},[side,amount,slippage,wallet.verifiedAddress]);
  const expired=!!quote&&Date.parse(quote.expiresAt)<=now, pending=receipt?.status==='SUBMITTED';
  const canTrade=enabled&&view.status==='LIVE'&&!!view.snapshot&&view.snapshot.phase!=='MIGRATING';
  const base=`/api/tokens/${view.mint}`;
  async function run(work:()=>Promise<void>) {setBusy(true);setError('');try{await work();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function getQuote() {await run(async()=>{setQuote(null);setReceipt(null);const bps=Math.round(Number(slippage)*100);if(!Number.isFinite(bps)||bps<10||bps>500)throw Error('Slippage must be 0.1–5%.');setQuote(await meteoraRequest(`${base}/trade`,{side,amount,slippageBps:bps}));});}
  async function submit() {await run(async()=>{if(!quote||!wallet.selected)throw Error('Connect wallet first.');if(Date.parse(quote.expiresAt)<=Date.now())throw Error('Quote expired. Request a new quote.');
    const signed=await signMeteoraTransaction(wallet.selected,quote.transaction,view.network as 'devnet'|'mainnet');
    // Server enforces expiry again after wallet prompt.
    const result=await meteoraRequest(`${base}/trade`,{action:'submit',stepId:quote.id,transaction:signed});setReceipt(result);setQuote(null);router.refresh();});}
  async function claim() {await run(async()=>{if(!wallet.selected)throw Error('Connect original creator wallet.');const prepared=await meteoraRequest(`${base}/claim`,{});
    if(!prepared.transaction){setReceipt(prepared);return;}
    const transaction=await signMeteoraTransaction(wallet.selected,prepared.transaction,view.network as 'devnet'|'mainnet');
    setReceipt(await meteoraRequest(`${base}/trade`,{action:'submit',stepId:prepared.id,transaction}));router.refresh();});}
  async function status() {await run(async()=>{if(!receipt)return;setReceipt(await meteoraRequest(`${base}/trade?id=${encodeURIComponent(receipt.id)}`));router.refresh();});}
  useEffect(()=>{if(!pending||!receipt)return;let cancelled=false;const timer=setTimeout(async()=>{try{const next=await meteoraRequest(`${base}/trade?id=${encodeURIComponent(receipt.id)}`);if(!cancelled){setReceipt(next);if(next.status==='CONFIRMED')router.refresh();}}catch(e){if(!cancelled)setError((e as Error).message);}},3000);return ()=>{cancelled=true;clearTimeout(timer);};},[receipt,pending,base,router]);
  return <section className={styles.card}>
    <p className={styles.eyebrow}>Native trading · {view.network}</p><h2>Buy / Sell ${view.symbol}</h2>
    <div className={styles.row} role="group" aria-label="Trade direction">{(['BUY','SELL'] as const).map(s=><button type="button" key={s} className={side===s?styles.button:styles.secondary} disabled={busy||pending} aria-pressed={side===s} onClick={()=>setSide(s)}>{s==='BUY'?'Buy':'Sell'}</button>)}</div>
    {!canTrade&&<p className={styles.notice}>{view.snapshot?.phase==='MIGRATING'?'Graduation in progress. Trading resumes after liquidity verification.':!enabled?'Trading awaits operator activation.':'Trading paused until pool is verified.'}</p>}
    <label className={styles.field}>Signing wallet<select aria-label="Connect trading wallet" value={wallet.selected?.wallet.name || ''} disabled={wallet.connecting||busy} onChange={e=>{const selected=wallet.wallets.find(w=>w.name===e.target.value);if(selected)void wallet.connect(selected);}}><option value="">Connect wallet</option>{wallet.wallets.map(w=><option key={w.name}>{w.name}</option>)}</select></label>
    {wallet.verifiedAddress&&<p className={styles.address}>{wallet.verifiedAddress}</p>}
    {!wallet.wallets.length&&<p className={styles.small}>Install a Solana Wallet Standard wallet supporting {view.network} to sign.</p>}
    <form className={styles.form} onSubmit={e=>{e.preventDefault();void getQuote();}}><label className={styles.field}>You pay · {side==='BUY'?'SOL':view.symbol}<input inputMode="decimal" placeholder="0.00" required value={amount} disabled={busy||pending} onChange={e=>setAmount(e.target.value)}/></label>
      <details><summary>Slippage · {slippage}%</summary><label className={styles.field}>Maximum slippage (%)<input type="number" min={0.1} max={5} step={0.1} value={slippage} onChange={e=>setSlippage(e.target.value)}/></label></details>
      <button className={styles.secondary} disabled={busy||pending||!canTrade||!wallet.selected||!amount}>{busy?'Checking…':'Get quote'}</button></form>
    {quote&&<div aria-live="polite"><div className={styles.stat}><span>You receive</span><strong>{formatUnits(quote.outputUnits,side==='BUY'?6:9)} {side==='BUY'?view.symbol:'SOL'}</strong></div><dl><dt>Minimum received</dt><dd>{formatUnits(quote.minimumOutputUnits,side==='BUY'?6:9)} {side==='BUY'?view.symbol:'SOL'}</dd><dt>Trading fee (included)</dt><dd>{formatUnits(quote.feeUnits)} SOL</dd><dt>Price impact</dt><dd>{quote.priceImpactPercent}%</dd><dt>Wallet balance</dt><dd>{formatUnits(quote.solBalanceUnits)} SOL · {formatUnits(quote.tokenBalanceUnits,6)} ${view.symbol}</dd></dl><p className={styles.small}>{expired?'Quote expired':`Quote expires in ${Math.max(0,Math.ceil((Date.parse(quote.expiresAt)-now)/1000))}s`}. Network/account fees additional.</p><button className={styles.button} disabled={busy||expired||!canTrade} onClick={()=>void submit()}>{busy?'Confirm in wallet…':`Confirm ${side==='BUY'?'buy':'sell'}`}</button></div>}
    {receipt&&<div role="status"><p>{receipt.status==='CONFIRMED'?'Transaction finalized ✓':receipt.status==='SUBMITTED'?'Submitted. Waiting for final confirmation.':receipt.error || receipt.status.toLowerCase()}</p>{pending&&<button className={styles.secondary} disabled={busy} onClick={()=>void status()}>Check transaction</button>}{receipt.signature&&<a className={styles.small} target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${receipt.signature}${view.network==='devnet'?'?cluster=devnet':''}`}>Transaction receipt ↗</a>}</div>}
    {view.isCreator&&<div><hr/><p className={styles.small}>Creator share stays directly claimable from original wallet.</p><p>{view.snapshot?formatUnits(view.snapshot.creatorClaimableUnits):'—'} SOL claimable</p><button className={styles.secondary} disabled={busy||pending||!wallet.selected||view.status!=='LIVE'} onClick={()=>void claim()}>Claim creator fees</button></div>}
    {(error||wallet.error)&&<p className={styles.error} role="alert">{error||wallet.error}</p>}
  </section>;
}
