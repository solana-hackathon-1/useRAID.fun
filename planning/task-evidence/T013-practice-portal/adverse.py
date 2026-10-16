from pathlib import Path
from datetime import datetime,timezone
import json
p=Path('tests/practice-portal-db.test.ts');s=p.read_text();s="import { PrismaClient } from '@prisma/client';\n"+s;i=s.rfind('\n});');s=s[:i]+'''
  it('paginates more than50 actual current families without overlap or accidental truncation',async()=>{
    for(let i=0;i<51;i++) await runCommandTransaction(db,tx=>publishPracticeTrialDefinition(tx,{actor:publisher,input:{...definitionInput(),trialId:'synthetic-page-'+String(i).padStart(3,'0')},idempotencyKey:randomUUID(),requestId:'pagination'},{allowNewWrites:true,canPublish:()=>true}));
    const first=await browse();expect(first.trials).toHaveLength(50);expect(first.nextCursor).toBe(first.trials.at(-1)?.definition.reference.recordId);
    const second=await browse(subject,first.nextCursor);expect(second.trials).toHaveLength(2);expect(second.nextCursor).toBeNull();expect(new Set([...first.trials,...second.trials].map(t=>t.definition.reference.recordId)).size).toBe(52);
  });
  it('never selects submission identifiers or private columns before authorizing a foreign own start',async()=>{
    await submit();const foreign=await actor(),sqls:string[]=[];
    const result=await runCommandTransaction(db,tx=>readOwnPracticeTrialProgress({...tx,async query<Row>(sql:string,bindings:readonly(string|null)[]){sqls.push(sql);return tx.query<Row>(sql,bindings);}},foreign,startId,()=>true));
    expect(result).toBeNull();expect(sqls.some(sql=>sql.includes('PracticeTrialSubmission'))).toBe(false);expect(sqls.some(sql=>sql.includes('"answer"'))).toBe(false);
  });
  it('rechecks actual own session after waiting for the original submission serialization lock',async()=>{
    const locker=new PrismaClient({transactionOptions:{timeout:15000,maxWait:10000}});let unlock!:()=>void;let locked!:()=>void;
    const held=new Promise<void>(r=>locked=r),release=new Promise<void>(r=>unlock=r);
    const lock=locker.$transaction(async tx=>{await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,12016))::text',startId);locked();await release;});
    try{
      await held;await db.session.update({where:{tokenHash:subject.sessionHash},data:{expiresAt:new Date(Date.now()+700)}});
      const reading=progress().then(value=>({value,error:null}),error=>({value:null,error}));
      const deadline=Date.now()+4000;let waiting=false;
      while(Date.now()<deadline){const rows=await db.$queryRawUnsafe<Array<{n:number}>>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'");if(rows[0].n){waiting=true;break;}await new Promise(r=>setTimeout(r,20));}
      expect(waiting).toBe(true);await db.$queryRawUnsafe('SELECT pg_sleep(0.8)::text');unlock();await lock;
      const result=await reading;expect(result.error).toMatchObject({code:'AUTHENTICATION_REQUIRED'});expect(result.value).toBeNull();
    }finally{unlock();await lock;await locker.$disconnect();}
  });
'''+s[i:];p.write_text(s)
e=Path('planning/task-evidence/T013-practice-portal');(e/'review.json').write_text(json.dumps({'status':'SELF-EVALUATED in progress','started_utc':datetime.now(timezone.utc).isoformat(),'agent':'Codex /root','base_head':'03b7fc3f56a0c0dd633fb27c9e46b69d70c9208c','task':'T013D8 protected practice discovery/start/private submission HTTP','independent':'NOT VERIFIED','browser_preview':'Not applicable to API-only slice; subsequent UI owns real browser preview','prior_wip':'PR228 postCI metadata preserved'},indent=2)+'\n')
