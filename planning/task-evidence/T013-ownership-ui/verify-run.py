import subprocess,os,signal
from pathlib import Path
root=Path.cwd();e=root/'planning/task-evidence/T013-ownership-ui'
import json
assert json.loads((e/'production-source-proof.json').read_text())['source']==Path('/tmp/raid-t013-ownership-ui-build-path').read_text(), 'Current build must finish before browser work'
class Interrupted(BaseException):
 def __init__(self,sig):self.code=128+sig
def interrupt(sig,frame):raise Interrupted(sig)
for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,interrupt)
try:
 for name,args in [('consumer-driver',['python3',str(e/'consumer-run.py')]),('browser-development',['python3',str(e/'browser-run.py'),'development']),('browser-production',['python3',str(e/'browser-run.py'),'production'])]:
  with (e/(name+'.log')).open('w') as out:
   p=subprocess.Popen(args,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
   try:code=p.wait()
   except BaseException:
    if p.poll() is None:
     os.killpg(p.pid,signal.SIGTERM)
     try:p.wait(timeout=12)
     except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
    raise
  print(name,code,flush=True)
  if code:raise SystemExit(code)
except Interrupted as error:raise SystemExit(error.code)
