from pathlib import Path
import subprocess,os,socket,time,urllib.request,urllib.error,json,signal,datetime,sys
root=Path('/srv/projects/useRAIDfun/useRAID-fun');source=Path('/tmp/raid-t008-build-source-2xavo66l');port=3025
with socket.socket() as s:
 if s.connect_ex(('127.0.0.1',port))==0:raise RuntimeError('Preserve occupied preview port')
base='http://127.0.0.1:'+str(port);env=dict(os.environ,NODE_ENV='development',DEMO_MODE='false',APP_URL=base,NEXT_PUBLIC_APP_URL=base,USDC_NETWORK='devnet',SKILL_TAXONOMY_ID='synthetic-submission-catalog',PRACTICE_ASSESSMENT_CATALOG_ID='synthetic-submission-catalog',SKILL_ASSESSMENT_READS_ENABLED='true',SKILL_CLAIMS_ENABLED='false',RAIDER_ONBOARDING_ENABLED='false',PRACTICE_TRIAL_ATTEMPTS_ENABLED='false',PRACTICE_TRIAL_SUBMISSIONS_ENABLED='false',PRACTICE_TRIAL_ASSESSMENTS_ENABLED='false',PRACTICE_ASSESSMENT_DECISIONS_ENABLED='false',ACCOUNT_FOLDS_ENABLED='false',WALLET_LINKS_ENABLED='false',LIVE_COLLECTION_APPROVED='false',LAUNCH_ENABLED='false',PAYOUT_ENABLED='false',X_TRACKING_V2_SETTLEMENT_ENABLED='false');server=None;code=1
mode=sys.argv[1] if len(sys.argv)>1 else 'green';log=Path('/tmp/raid-t013-own-assessment-view-browser-'+mode+'-server.log').open('w');meta={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':str(source),'base':'0e6b55fcdbd12f9648f2185301bb59649e5d2e70+currentWIP','url':base+'/raider/skills/frontend','mode':'Next16.3.8 development/webpack/actual syntheticPG35/real own sessions','access':'Verified loopback in this environment; remote forwarding unavailable/unverified','production_build_separate':True}
try:
 server=subprocess.Popen(['node_modules/.bin/next','dev','--webpack','--hostname','127.0.0.1','--port',str(port)],cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);meta['pid']=server.pid;meta['pgid']=server.pid
 for _ in range(180):
  if server.poll() is not None:raise RuntimeError('Owned preview exited before readiness')
  try:
   with urllib.request.urlopen(base+'/raider/skills/frontend',timeout=2) as r:
    if r.status==200:break
  except (urllib.error.URLError,TimeoutError,socket.timeout):time.sleep(.25)
 else:raise RuntimeError('Owned preview readiness failed')
 print('OWNED VERIFIED PREVIEW:',json.dumps(meta),flush=True);Path('/tmp/raid-t013-own-assessment-view-preview-current.json').write_text(json.dumps(meta,indent=2)+'\n')
 if mode=='hold':time.sleep(120)
 testenv=dict(os.environ,NODE_ENV='test',OWN_ASSESSMENT_BROWSER_URL=base,OWN_ASSESSMENT_CHROMIUM_EXECUTABLE_PATH='/home/rpandox/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome');cmd=['node_modules/.bin/playwright','test','--config=playwright.own-assessments.config.ts']
 if mode=='red':cmd+=['--project=desktop','-g','owner sees actual current assessment']
 code=subprocess.run(cmd,cwd=root,env=testenv).returncode
finally:
 if server is not None and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait(timeout=5)
 log.close();meta['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();meta['server_exit_code']=server.returncode if server else None
 with socket.socket() as s:meta['owned_port_closed']=s.connect_ex(('127.0.0.1',port))!=0
 if not meta['owned_port_closed']:code=1
 Path('/tmp/raid-t013-own-assessment-view-browser-'+mode+'-lifecycle.json').write_text(json.dumps(meta,indent=2)+'\n');print('OWNED PREVIEW CLEANUP:',json.dumps({'pid':meta.get('pid'),'owned_port_closed':meta['owned_port_closed'],'server_exit':meta['server_exit_code']}),flush=True)
sys.exit(code)
