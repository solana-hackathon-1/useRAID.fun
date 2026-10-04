'use client';
import { useEffect, useState } from 'react';
import { formatUnits } from '@/lib/meteora/amounts';
import { meteoraRequest } from './meteora-launch-wizard';
import { AdminAction } from './admin';
type View={readiness:{network:string;issues:string[]};launches:{id:string;name:string;status:string;error:string|null;workerObservedAt:string|null}[];
  payouts:{id:string;status:string;asset:string;units:string;walletAddress:string;network:string;launch:{symbol:string;mint:string}}[]};
export function MeteoraOperations({launchPaused,payoutPaused}:{launchPaused:boolean;payoutPaused:boolean}) {
  const [view,setView]=useState<View|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[reason,setReason]=useState('');
  const load=async()=>setView(await meteoraRequest('/api/admin/meteora'));
  useEffect(()=>{let active=true;meteoraRequest('/api/admin/meteora').then(v=>{if(active)setView(v);}).catch(e=>{if(active)setError(e.message);});return ()=>{active=false;};},[]);
  async function review(id:string,action:'approve'|'hold') {setBusy(id);setError('');try{await meteoraRequest('/api/admin/meteora',{id,action,reason});await load();}catch(e){setError((e as Error).message);}finally{setBusy('');}}
  return <section className="panel" id="meteora-finance"><h2>Meteora launch operations</h2>
    <p>{view?`${view.readiness.network} · Reviewed SOL and token payouts. Operator covers transaction costs.`:'Loading launch health…'}</p>
    <p>New launches {launchPaused?'paused':'allowed'} · New payouts {payoutPaused?'paused':'allowed'}. Deployment switches must also be enabled.</p>
    <div className="form-actions">
      <AdminAction action="finance" id="global" label={launchPaused?'Resume launches':'Pause launches'} values={{launchPaused:!launchPaused,payoutPaused}}/>
      <AdminAction action="finance" id="global" label={payoutPaused?'Resume payouts':'Pause payouts'} values={{launchPaused,payoutPaused:!payoutPaused}}/>
    </div>
    {!!view?.readiness.issues.length&&<details><summary>Configuration readiness</summary>{view.readiness.issues.map(i=><p key={i}>{i}</p>)}</details>}
    {view?.launches.map(l=><div className="admin-row" key={l.id}><strong>{l.name} · {l.status}</strong><p>Worker {l.workerObservedAt&&Date.now()-Date.parse(l.workerObservedAt)<120000?'ready':'unavailable'}{l.error?` · ${l.error}`:''}</p></div>)}
    <h3>Reviewed allocations awaiting payment</h3><label className="field">Review note / hold reason<input value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/></label>
    {view&&!view.payouts.length&&<p>No outstanding allocations.</p>}{view?.payouts.map(p=><div className="admin-row" key={p.id}><strong>{formatUnits(p.units,p.asset==='SOL'?9:6)} {p.asset==='SOL'?'SOL':p.launch.symbol} · {p.status}</strong><p>{p.network} · Token: <span className="mint">{p.launch.mint}</span></p><p>Verified recipient: <span className="mint">{p.walletAddress}</span></p>
      {['PENDING','HELD'].includes(p.status)&&<div className="form-actions"><button className="button" disabled={!!busy} onClick={()=>void review(p.id,'approve')}>{busy===p.id?'Saving…':'Approve payment'}</button><button className="button secondary" disabled={!!busy||!reason.trim()} onClick={()=>void review(p.id,'hold')}>Hold</button></div>}</div>)}
    {error&&<p role="alert" className="form-error">{error}</p>}
  </section>;
}
