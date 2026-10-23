import os, subprocess, sys, time, json, signal
from pathlib import Path
name='raid-t013-assignment-management-preview-20261023'
label='T013-assignment-management-preview'
Path('/tmp/raid-assignment-management-preview-owner.pid').write_text(str(os.getpid()))
image='postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
class Interrupted(BaseException):
 def __init__(self, signum): self.code=128+signum
def interrupt(signum, _frame): raise Interrupted(signum)
for signum in [signal.SIGTERM,signal.SIGINT]: signal.signal(signum,interrupt)
def child(args,check=True,**kwargs):
 # A separate session owns the entire child group, including npm/tsx descendants.
 process=subprocess.Popen(args,start_new_session=True,**kwargs)
 try: code=process.wait()
 except BaseException:
  if process.poll() is None:
   os.killpg(process.pid,signal.SIGTERM)
   try: process.wait(timeout=15)
   except subprocess.TimeoutExpired:
    os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
  raise
 if check and code: raise subprocess.CalledProcessError(code,args)
 return code
owned=False;code=1
try:
 result=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
 if result.returncode==0:
  item=json.loads(result.stdout)[0]
  if item['Config']['Labels'].get('raid.task')!=label or item['State']['Running']: raise RuntimeError('Unexpected existing resource identity/state')
  owned=True;child(['docker','start',name])
 else:
  # Cleanup may inspect this exact label/name even if interrupted during creation.
  owned=True;child(['docker','run','-d','--name',name,'--label','raid.task='+label,'-p','127.0.0.1:0:5432','--tmpfs','/var/lib/postgresql/data:rw,size=536870912','-e','POSTGRES_PASSWORD=synthetic-only','-e','POSTGRES_DB=useraid_test',image])
 for _ in range(120):
  if subprocess.run(['docker','exec',name,'pg_isready','-U','postgres','-d','useraid_test'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
  time.sleep(.25)
 else: raise RuntimeError('Owned database not ready')
 port=json.loads(subprocess.check_output(['docker','inspect',name]))[0]['NetworkSettings']['Ports']['5432/tcp'][0]['HostPort']
 print('OWNED DATABASE:',name,'loopback port',port,flush=True)
 env=dict(os.environ,DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:'+port+'/useraid_test',RUN_DB_TESTS='true',NODE_ENV='test',DEMO_MODE='false',ADMIN_X_IDS='',X_ADMIN_USER_ID='')
 child(['node_modules/.bin/prisma','migrate','deploy'],env=env)
 code=child(sys.argv[1:],check=False,env=env)
except Interrupted as error:
 code=error.code;print('OWNED INTERRUPTION:',code,flush=True)
finally:
 # A second interruption cannot bypass shutdown of this exact verified task resource.
 for signum in [signal.SIGTERM,signal.SIGINT]: signal.signal(signum,signal.SIG_IGN)
 if owned:
  result=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
  if result.returncode==0:
   item=json.loads(result.stdout)[0]
   if item['Config']['Labels'].get('raid.task')!=label:
    print('OWNED CLEANUP REFUSED: unexpected label',flush=True);code=1
   else:
    stopped=subprocess.run(['docker','stop',name],capture_output=True,text=True,timeout=20)
    print('OWNED CLEANUP:',stopped.returncode,stopped.stdout.strip(),stopped.stderr.strip(),flush=True)
    if stopped.returncode:code=1
sys.exit(code)
