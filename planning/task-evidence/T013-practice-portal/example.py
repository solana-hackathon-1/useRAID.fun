from pathlib import Path
import shutil,json,os
r=Path.cwd();dst=r/'examples/practice-portal';src=r/'examples/practice-trial-submissions'
shutil.copytree(src,dst,symlinks=True,dirs_exist_ok=True)
p=dst/'package.json';d=json.loads(p.read_text());d['name']='raid-practice-portal-example';p.write_text(json.dumps(d,indent=2)+'\n')
p=dst/'package-lock.json';d=json.loads(p.read_text());d['name']='raid-practice-portal-example';d['packages']['']['name']=d['name'];p.write_text(json.dumps(d,indent=2)+'\n')
p=dst/'connection.ts';p.write_text(p.read_text().replace('useraid_practice_submission_host_test','useraid_practice_portal_host_test'))
(dst/'http-contracts').symlink_to('../../src/http-contracts',target_is_directory=True)
for name in ['practice-portal-contracts.ts','practice-portal-storage.ts','practice-portal-http.ts']:(dst/'skills'/name).symlink_to('../../../src/skills/'+name)
p=dst/'host.ts';s=p.read_text();s="import { createPracticePortalHandlers, PracticePortalHttpError } from './skills/practice-portal-http';\nimport { listOwnPracticeTrials, readOwnPracticeTrialProgress } from './skills/practice-portal-storage';\n"+s
start=s.index('  const started = await begin();')
s=s[:start]+'''  let currentLearner=learner, startsEnabled=true, submissionsEnabled=true;
  const handlers=createPracticePortalHandlers({
    version:'v1',requestId:()=> 'synthetic-http-request',actor:async()=>currentLearner,
    checkOrigin:r=>{if(r.headers.get('origin')!=='https://synthetic.test')throw new PracticePortalHttpError(403);},
    rateLimit:()=>{},
    list:(a,after)=>transaction(tx=>listOwnPracticeTrials(tx,a,{version:'v1',taxonomyId:catalogId,after},()=>true)),
    read:(a,id)=>transaction(tx=>readOwnPracticeTrialProgress(tx,a,id,()=>true)),
    start:async c=>({version:'v1',...await transaction(tx=>startPracticeTrial(tx,c,{allowNewWrites:startsEnabled,canStart:s=>startsEnabled&&s.taxonomyId===catalogId})),writesAvailable:startsEnabled,unavailableReason:startsEnabled?null:'DISABLED'}),
    submit:async c=>({version:'v1',...await transaction(tx=>submitPracticeTrial(tx,c,{allowNewWrites:submissionsEnabled,canSubmit:()=>submissionsEnabled})),writesAvailable:submissionsEnabled,unavailableReason:submissionsEnabled?null:'DISABLED'}),
  });
  const request=(body:unknown,key:string)=>new Request('https://synthetic.test/api/v1/practice/starts',{method:'POST',headers:{origin:'https://synthetic.test','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
  const catalogResponse=await handlers.LIST(new Request('https://synthetic.test/api/v1/practice'));
  assert.equal(catalogResponse.status,200);assert.equal(catalogResponse.headers.get('cache-control'),'private, no-store');
  const catalog=await catalogResponse.json();assert.equal(catalog.trials.length,1);assert.equal('publishedByAccountId' in catalog.trials[0],false);
  const httpStartKey=randomUUID(),startBody={version:'v1',definitionReference:first.trial.definition.reference,accommodationReference:null};
  const startedResponse=await handlers.START(request(startBody,httpStartKey));assert.equal(startedResponse.status,200);
  const started=await startedResponse.json();
''' +s[start+len('  const started = await begin();'):]
# There are only2allowed attempts: retain original direct second begin, original direct begin replay later uses key not httpStartKey. Route original begin to same durable key.
s=s.replace('const originalStart = await begin(false);','const originalStartResponse=await handlers.START(request(startBody,httpStartKey));\n  const originalStart=await originalStartResponse.json();')
s=s.replace("assert.deepEqual((await begin(false)).start, started.start);","assert.deepEqual((await (await handlers.START(request(startBody,httpStartKey))).json()).start, started.start);")
s=s.replace("  await assert.rejects(() => begin(false), /AUTHENTICATION_REQUIRED/);","  assert.equal((await handlers.START(request(startBody,httpStartKey))).status,401);")
s=s.replace('  const submitted = await submit();',"  const submittedResponse=await handlers.SUBMIT(request(submissionInput,submissionKey),started.start.id);\n  assert.equal(submittedResponse.status,200);const submitted=await submittedResponse.json();\n  const progressResponse=await handlers.READ(new Request('https://synthetic.test/api/v1/practice'),started.start.id);assert.equal(progressResponse.status,200);const actualProgress=await progressResponse.json();assert.equal(actualProgress.progress,'SUBMITTED');assert.equal(actualProgress.start.state,'STARTED');assert.equal(actualProgress.submission.answer,submissionInput.answer);\n  currentLearner=actor;assert.equal((await handlers.READ(new Request('https://synthetic.test/api/v1/practice'),started.start.id)).status,404);currentLearner=learner;")
s=s.replace('  const originalSubmission = await submit(submissionInput, submissionKey, false);',"  startsEnabled=false;submissionsEnabled=false;\n  const originalSubmission=await (await handlers.SUBMIT(request(submissionInput,submissionKey),started.start.id)).json();")
s=s.replace("  assert.equal(retired.trial.availability, 'RETIRED');","  assert.equal(retired.trial.availability, 'RETIRED');\n  assert.deepEqual((await (await handlers.LIST(new Request('https://synthetic.test/api/v1/practice'))).json()).trials,[]);")
s=s.replace('      synthetic: true,','      portablePrivateHttp: true,\n      catalogDiscoveryAndPrivateProgress: true,\n      httpRetryAfterRetirementAndWriteoff: true,\n      synthetic: true,')
p.write_text(s)
(dst/'README.md').write_text('''# Independent practice portal HTTP host

This host owns real npm dependencies, account/session/HUMAN identity, bounded READ COMMITTED SQL transactions, scoped catalog/publication/write policy and origin/rate/HTTP ports. It uses canonical source symlinks locally; copy with symlinks dereferenced into another project. No Root Prisma, Next, auth, environment, provider or generated client is imported. PostgreSQL16 with minimal schemas through private submission30 is sufficient; full Root verification uses all35migrations. No assessment schema or rank is fabricated.

Use Node22.12+, an isolated loopback PostgreSQL database named `useraid_practice_portal_host_test`, and a nonproduction environment. Set DATABASE_URL explicitly. Run `npm ci`, `npm run typecheck`, `npm run migrate`, `npm start`. The schema/database must be dedicated synthetic fixtures. The caller owns database lifecycle and stops its container after success/failure/interruption; the host closes its own pool in finally. It never creates a server/listener or changes unrelated data.

Actual HTTP handlers consume real commands: current safe catalog, exact original start, private saved progress, owner-only read, maximum family attempts, original submission retry after retirement/writeoff, truthful immutable unconfirmed declaration, session revocation and no access/capacity/money/rank. Origin/rate ports are explicit host responsibilities, never policy inferred from a client actor. This synthetic host uses deterministic no-op rate accounting, not a production rate limiter. It verifies independent consumption, not independent review or UAT. See ../../docs/raid-practice-portal.md.
''')
