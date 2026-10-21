import os,subprocess,json,hashlib
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit
root=Path.cwd();e=root/'planning/task-evidence/T013-review-inbox'
source=root/'examples/practice-review-reads';consumer=Path(Path('/tmp/raid-t013-review-inbox-consumer-path').read_text())
# Create only a synthetic database in the outer runner's owned loopback PostgreSQL.
subprocess.run(['node','--input-type=module','-e',"import pg from 'pg'; const p=new pg.Pool({connectionString:process.env.DATABASE_URL});try{await p.query('CREATE DATABASE useraid_practice_review_read_host_test')}finally{await p.end()}"],cwd=consumer,check=True)
u=urlsplit(os.environ['DATABASE_URL']);env=dict(os.environ,DATABASE_URL=urlunsplit((u.scheme,u.netloc,'/useraid_practice_review_read_host_test','','')))
for name,args in [('consumer-migrate',['npm','run','migrate']),('consumer',['npm','start'])]:
 with (e/(name+'.log')).open('w') as out:r=subprocess.run(args,cwd=consumer,env=env,stdout=out,stderr=subprocess.STDOUT)
 print(name,r.returncode,flush=True)
 if r.returncode:raise SystemExit(r.returncode)
hashes={}
for p in consumer.rglob('*'):
 if not p.is_file() or 'node_modules' in p.parts:continue
 relative=p.relative_to(consumer);original=source/relative
 if not original.is_file() or original.read_bytes()!=p.read_bytes():raise RuntimeError('Consumer source mismatch '+str(relative))
 hashes[str(relative)]=hashlib.sha256(p.read_bytes()).hexdigest()
(e/'consumer-source-proof.json').write_text(json.dumps({'consumer':str(consumer),'independentNodeModules':not(consumer/'node_modules').is_symlink(),'matchingFiles':len(hashes),'sha256':hashes},indent=2)+'\n')
