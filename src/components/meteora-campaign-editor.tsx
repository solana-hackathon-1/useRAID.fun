'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatUnits, launchTemplate, type MeteoraNetwork } from '@/lib/meteora/amounts';
import styles from './meteora.module.css';
type Campaign = { id:string;title:string;description:string;status:string;impressionTarget:number|null;duration:number;targetPosts:string[];draftBudgets?:{solBudget:string;tokenBudget:string}|null };
export type CampaignEditorData = {launchId:string;name:string;symbol:string;mint:string;network:MeteoraNetwork;xConnected:boolean;
  balances:{sol:{available:string;reserved:string;paid:string};token:{available:string;reserved:string;paid:string}};raids:Campaign[]};
export function MeteoraCampaignEditor({data}:{data:CampaignEditorData}) {
  const router=useRouter(), initial=data.raids.find(r=>r.status==='DRAFT');
  const [form,setForm]=useState({raidId:initial?.id,title:initial?.title || `${data.name} community raid`,description:initial?.description || '',
    impressionTarget:initial?.impressionTarget || 10000,duration:[6,12,24,72,168].includes(initial?.duration || 0)?initial!.duration:24,
    solBudget:initial?.draftBudgets?.solBudget || launchTemplate(data.network).minimumCampaignSol, tokenBudget:initial?.draftBudgets?.tokenBudget || '0',
    targetPosts:initial?.targetPosts.join('\n') || '',termsAccepted:false});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  async function save(start:boolean) {
    setBusy(true);setError('');setSaved(false);
    try {
      const r=await fetch(`/api/launch/${data.launchId}/campaign`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...form,
        targetPosts:form.targetPosts.split(/\n+/).map(s=>s.trim()).filter(Boolean),action:start?'start':'save'})});
      const result=await r.json();if(!r.ok)throw Error(result.error || 'Could not save campaign.');
      setForm(f=>({...f,raidId:result.id}));
      if(start)router.push(`/creator/raids/${result.id}`);else {setSaved(true);router.refresh();}
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className={styles.page}>
    <Link className={styles.small} href={`/tokens/${data.mint}`}>← ${data.symbol} token page</Link>
    <header className={styles.header}><div><p className={styles.eyebrow}>{data.network} · Community growth</p><h1>Turn trading into attention.</h1><p>Add X posts. Choose a budget. Start your raid.</p></div></header>
    <div className={styles.grid}><section className={styles.card}>
      {!data.xConnected&&<div className={styles.notice}>Connect your X account to validate target posts and run campaigns. <Link href="/api/auth/x">Connect X →</Link></div>}
      <form className={styles.form} onSubmit={e=>{e.preventDefault();void save(true);}}>
        <label className={styles.field}>Campaign name<input required maxLength={120} minLength={3} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label>
        <label className={styles.field}>Target X posts<textarea required placeholder="https://x.com/yourproject/status/…" value={form.targetPosts} onChange={e=>setForm({...form,targetPosts:e.target.value})}/><small>One public post per line. Raiders quote or link these posts and mention @useRAID.</small></label>
        <label className={styles.field}>Brief · optional<textarea maxLength={2000} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label>
        <div className={styles.row}><label className={styles.field}>Impression target<input type="number" required min={1000} max={1000000000} step={1} value={form.impressionTarget} onChange={e=>setForm({...form,impressionTarget:Number(e.target.value)})}/></label>
        <label className={styles.field}>Duration<select value={form.duration} onChange={e=>setForm({...form,duration:Number(e.target.value)})}>{[6,12,24,72,168].map(h=><option key={h} value={h}>{h<48?`${h} hours`:`${h/24} days`}</option>)}</select></label></div>
        <div className={styles.row}><label className={styles.field}>SOL reward budget<input required inputMode="decimal" value={form.solBudget} onChange={e=>setForm({...form,solBudget:e.target.value})}/><small>Minimum {launchTemplate(data.network).minimumCampaignSol} SOL</small></label>
        <label className={styles.field}>${data.symbol} rewards · optional<input inputMode="decimal" value={form.tokenBudget} onChange={e=>setForm({...form,tokenBudget:e.target.value})}/><small>Supplement SOL rewards after graduation.</small></label></div>
        <label className={styles.small}><input type="checkbox" checked={form.termsAccepted} onChange={e=>setForm({...form,termsAccepted:e.target.checked})}/> Rewards depend on reviewed qualifying impressions. Two-hour review; unused funds and rounding return to this campaign balance. Zero qualifying impressions means zero payout.</label>
        <div className={styles.row}><button className={styles.secondary} type="button" disabled={busy||!data.xConnected} onClick={()=>void save(false)}>{busy?'Saving…':'Save draft'}</button><button className={styles.button} disabled={busy||!form.termsAccepted||!data.xConnected}>{busy?'Starting…':'Start raid →'}</button></div>
        {error&&<p className={styles.error} role="alert">{error}</p>}{saved&&<p role="status">Draft saved. No funds reserved.</p>}
      </form>
    </section><aside><section className={styles.card}><p className={styles.eyebrow}>Your campaign balance</p><h2>Ready when funded.</h2><div className={styles.stat}><span>Available now</span><strong>{formatUnits(data.balances.sol.available)} SOL</strong></div><div className={styles.stat}><span>Reserved for live raids</span><strong>{formatUnits(data.balances.sol.reserved)} SOL</strong></div><div className={styles.stat}><span>Available token rewards</span><strong>{formatUnits(data.balances.token.available,6)} ${data.symbol}</strong></div><p className={styles.small}>20% of distributable fees from launch-owned liquidity replenish this balance. New receipts never change a live raid’s budget.</p><p className={styles.small}>Campaign starts when funding, X collection and payout worker are ready. Operator pays payout network costs.</p></section>
      <section className={styles.card}><h2>Campaigns</h2>{data.raids.map(r=><p key={r.id}><Link href={`/creator/raids/${r.id}`}>{r.title}</Link> · {r.status.toLowerCase()}</p>)}</section></aside></div>
  </div>;
}
