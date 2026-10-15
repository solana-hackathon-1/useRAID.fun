from pathlib import Path
import subprocess,os,signal,time,json
name='raid-t013-review-reads-auto-20261015';marker=Path('/tmp/raid-t013-review-reads-cleanup-signal-ready');marker.unlink(missing_ok=True)
with Path('/tmp/raid-t013-review-reads-cleanup-signal-green.log').open('w') as out:
 process=subprocess.Popen(['python3','/tmp/raid-t013-review-reads-db-run.py','python3','-c',"from pathlib import Path;import time;Path('/tmp/raid-t013-review-reads-cleanup-signal-ready').write_text('ready');time.sleep(30)"],stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  for _ in range(100):
   if marker.exists():break
   if process.poll() is not None:raise RuntimeError('Runner exited before owned child ready')
   time.sleep(.2)
  else:raise RuntimeError('Owned child not ready')
  os.kill(process.pid,signal.SIGTERM);code=process.wait(timeout=20);state=json.loads(subprocess.check_output(['docker','inspect',name]))[0];assert state['Config']['Labels']['raid.task']=='T013-review-reads'
  observed={'signal':'SIGTERM','parent_exit':code,'running_after_parent_exit':state['State']['Running'],'expected_running':False,'result':'PASS' if code==143 and state['State']['Running'] is False else 'FAIL'};Path('/tmp/raid-t013-review-reads-cleanup-signal-green.json').write_text(json.dumps(observed,indent=2)+'\n');print(json.dumps(observed),flush=True);assert observed['result']=='PASS'
 finally:
  if process.poll() is None:os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=20)
  state=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
  if state['State']['Running']:
   assert state['Config']['Labels']['raid.task']=='T013-review-reads';subprocess.run(['docker','stop',name],check=True,stdout=out,stderr=subprocess.STDOUT)
