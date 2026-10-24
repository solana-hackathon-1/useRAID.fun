import os,signal,socket,subprocess,time,json,threading,urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
root=Path.cwd();e=root/'planning/task-evidence/T013-current-review-20261024';source=Path((e/'source-path.txt').read_text().strip())
class Interrupted(BaseException):
 def __init__(self,sig):self.code=128+sig
def interrupt(sig,frame):raise Interrupted(sig)
for sig in [signal.SIGINT,signal.SIGTERM]:signal.signal(sig,interrupt)
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
url='http://127.0.0.1:'+str(port)
env=dict(os.environ,NODE_ENV='development',NEXT_TELEMETRY_DISABLED='1',DEMO_MODE='false',ADMIN_X_IDS='synthetic-management-admin-x',X_ADMIN_USER_ID='',APP_URL=url,NEXT_PUBLIC_APP_URL=url,USDC_NETWORK='devnet',PRACTICE_REVIEW_READS_ENABLED='false',PRACTICE_REVIEW_ASSIGNMENTS_ENABLED='true',PRACTICE_PORTAL_READS_ENABLED='false',PRACTICE_TRIAL_ATTEMPTS_ENABLED='false',PRACTICE_TRIAL_SUBMISSIONS_ENABLED='false',SKILL_ASSESSMENT_READS_ENABLED='false',SKILL_CLAIMS_ENABLED='false',RAIDER_ONBOARDING_ENABLED='false',PRACTICE_TRIAL_ASSESSMENTS_ENABLED='false',PRACTICE_ASSESSMENT_DECISIONS_ENABLED='false',ACCOUNT_FOLDS_ENABLED='false',WALLET_LINKS_ENABLED='false',LIVE_COLLECTION_APPROVED='false',LAUNCH_ENABLED='false',PAYOUT_ENABLED='false',X_TRACKING_V2_SETTLEMENT_ENABLED='false')
secret=Path('/tmp/raid-management-preview-'+str(os.getpid())+'.json')
server=None;helper=None;code=1;log=(e/'preview-next.log').open('w')
try:
 subprocess.run(['node_modules/.bin/tsx','tests/helpers/practice-assignment-management-preview-seed.ts'],cwd=root,env=dict(env,NODE_ENV='test',RAID_MANAGEMENT_PREVIEW='synthetic-only',RAID_MANAGEMENT_PREVIEW_FILE=str(secret)),check=True)
 fixture=json.loads(secret.read_text());secret.unlink()
 server=subprocess.Popen(['node_modules/.bin/next','dev','--webpack','--hostname','127.0.0.1','--port',str(port)],cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 deadline=time.monotonic()+60
 while time.monotonic()<deadline:
  try:
   with urllib.request.urlopen(url+'/methodology',timeout=2) as response:
    if response.status==200:break
  except Exception:
   if server.poll() is not None:raise RuntimeError('Owned preview exited')
   time.sleep(.2)
 else:raise RuntimeError('Owned preview unreachable')
 class Handler(BaseHTTPRequestHandler):
  def do_GET(self):
   if self.path!='/open':self.send_error(404);return
   self.send_response(303);self.send_header('Cache-Control','private, no-store')
   self.send_header('Set-Cookie','raid_session='+fixture['cookie']+'; Path=/; HttpOnly; SameSite=Lax')
   self.send_header('Location',url+fixture['path']);self.end_headers()
  def log_message(self,*args):pass
 helper=ThreadingHTTPServer(('127.0.0.1',0),Handler)
 threading.Thread(target=helper.serve_forever,daemon=True).start()
 resource={'mode':'development','source':str(source),'syntheticOnly':True,'runnerPid':os.getpid(),'serverPid':server.pid,'url':url+fixture['path'],'openUrl':'http://127.0.0.1:'+str(helper.server_port)+'/open','serverPort':port,'helperPort':helper.server_port,'databaseContainer':'raid-t013-current-review-preview-20261024','purpose':'Owner-retained synthetic preview; no production auth bypass/flags/appointments','result':'RUNNING'}
 (e/'preview-resources.json').write_text(json.dumps(resource,indent=2)+'\n')
 print('OWNED SYNTHETIC PREVIEW READY:',resource['openUrl'],flush=True)
 while server.poll() is None:time.sleep(.5)
 raise RuntimeError('Owned preview server exited')
except Interrupted as error:code=error.code
finally:
 for sig in [signal.SIGINT,signal.SIGTERM]:signal.signal(sig,signal.SIG_IGN)
 if helper:helper.shutdown();helper.server_close()
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=8)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait(timeout=5)
 if secret.exists():secret.unlink()
 log.close();print('OWNED PREVIEW SERVER/HELPER STOPPED',flush=True)
raise SystemExit(code)
