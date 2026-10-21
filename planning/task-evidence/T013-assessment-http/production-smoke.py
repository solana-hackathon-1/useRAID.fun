import os,subprocess,signal,socket,time,json,urllib.request,urllib.error
from pathlib import Path
root=Path.cwd();e=root/'planning/task-evidence/T013-assessment-http';source=Path(Path('/tmp/raid-t013-assessment-http-build-path').read_text())
class Interrupted(BaseException):
 def __init__(self,sig):self.code=128+sig
def interrupt(sig,frame):raise Interrupted(sig)
for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,interrupt)
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
url='http://127.0.0.1:'+str(port)
env=dict(os.environ,NODE_ENV='production',NEXT_TELEMETRY_DISABLED='1',DEMO_MODE='false',APP_URL=url,NEXT_PUBLIC_APP_URL=url,DATABASE_URL='postgresql://synthetic:synthetic@127.0.0.1:9/useraid_disabled_test',ADMIN_X_IDS='',X_ADMIN_USER_ID='',PRACTICE_REVIEW_READS_ENABLED='false',PRACTICE_TRIAL_ASSESSMENTS_ENABLED='false',PRACTICE_ASSESSMENT_DECISIONS_ENABLED='false')
p=None;code=1;checks=[]
with (e/'production-server.log').open('w') as out:
 try:
  p=subprocess.Popen(['node_modules/.bin/next','start','--hostname','127.0.0.1','--port',str(port)],cwd=source,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
  for _ in range(120):
   try:
    with urllib.request.urlopen(url+'/methodology',timeout=1) as response:
     if response.status==200:break
   except Exception:
    if p.poll() is not None:raise RuntimeError('Owned server exited')
    time.sleep(.25)
  else:raise RuntimeError('Owned server unreachable')
  endpoint=url+'/api/v1/practice/reviews/00000000-0000-4000-8000-000000000001/submissions/00000000-0000-4000-8000-000000000002/assessment'
  for suffix in ['', '/state','/decisions']:
   for method,origin,status in ([('GET',None,401),('HEAD',None,401)] if suffix=='/state' else [('GET',None,401),('HEAD',None,401),('POST',url,401),('POST','https://foreign.example',403)]):
    request=urllib.request.Request(endpoint+suffix,method=method,headers={'Origin':origin} if origin else {},data=b'{}' if method=='POST' else None)
    try:response=urllib.request.urlopen(request,timeout=10)
    except urllib.error.HTTPError as error:response=error
    with response:
     text=response.read().decode();vary=','.join(response.headers.get_all('Vary') or [])
     assert response.status==status,(method,response.status)
     assert 'private' in response.headers.get('Cache-Control','') and 'no-store' in response.headers.get('Cache-Control','')
     assert 'cookie' in [x.strip().lower() for x in vary.split(',')]
     assert response.headers.get('Access-Control-Allow-Origin') is None
     if method=='HEAD':assert not text
     else:assert json.loads(text)['error']['code']==('AUTHENTICATION_REQUIRED' if status==401 else 'FORBIDDEN')
     checks.append({'route':suffix or '/assessment','method':method,'origin':origin,'status':status,'privateNoStore':True,'varyCookie':True,'safeBody':True})
  code=0
 except Interrupted as error:code=error.code
 finally:
  for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,signal.SIG_IGN)
  if p is not None and p.poll() is None:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=8)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
  with socket.socket() as s:closed=s.connect_ex(('127.0.0.1',port))!=0
  if not closed:code=1
  (e/'production-smoke.json').write_text(json.dumps({'mode':'production next start','source':str(source),'port':port,'pid':p.pid if p else None,'checks':checks,'ownedServerStopped':closed,'result':code},indent=2)+'\n')
  print('COMPILED ROUTE:',len(checks),'checks; owned server closed',closed,'result',code)
raise SystemExit(code)
