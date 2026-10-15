import os,subprocess,sys,time,json
from pathlib import Path
name='raid-t013-practice-unicode-auto-20261015'
image='postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
def run(args,**kw): return subprocess.run(args,check=True,**kw)
# Only this uniquely named, labelled synthetic fixture may be started/stopped.
r=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
if r.returncode==0:
 item=json.loads(r.stdout)[0]
 if item['Config']['Labels'].get('raid.task')!='T013-practice-unicode' or item['State']['Running']: raise SystemExit('Unexpected existing resource identity/state')
 run(['docker','start',name])
else:
 run(['docker','run','-d','--name',name,'--label','raid.task=T013-practice-unicode','-p','127.0.0.1:0:5432','--tmpfs','/var/lib/postgresql/data:rw,size=536870912','-e','POSTGRES_PASSWORD=synthetic-only','-e','POSTGRES_DB=useraid_test',image])
code=1
try:
 for _ in range(120):
  if subprocess.run(['docker','exec',name,'pg_isready','-U','postgres','-d','useraid_test'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
  time.sleep(.25)
 else: raise RuntimeError('Owned database not ready')
 port=json.loads(subprocess.check_output(['docker','inspect',name]))[0]['NetworkSettings']['Ports']['5432/tcp'][0]['HostPort']
 print('OWNED DATABASE:',name,'loopback port',port,flush=True)
 env=dict(os.environ,DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:'+port+'/useraid_test',RUN_DB_TESTS='true',NODE_ENV='test')
 run(['node_modules/.bin/prisma','migrate','deploy'],env=env)
 code=subprocess.run(sys.argv[1:],env=env).returncode
finally:
 r=subprocess.run(['docker','stop',name],capture_output=True,text=True)
 print('OWNED CLEANUP:',r.returncode,r.stdout.strip(),r.stderr.strip(),flush=True)
 if r.returncode: code=1
sys.exit(code)
