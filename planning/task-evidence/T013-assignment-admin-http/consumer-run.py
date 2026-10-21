import os,subprocess
from urllib.parse import urlsplit,urlunsplit
from pathlib import Path
e=Path('planning/task-evidence/T013-assignment-admin-http');consumer=Path('/private/tmp/claude-501/-Users-dushyant-Documents-useRAID-fun/ca795d81-cf02-419b-9387-9de12c703c4a/scratchpad/consumer')
subprocess.run(['node','--input-type=module','-e',"import pg from 'pg'; const p=new pg.Pool({connectionString:process.env.DATABASE_URL});try{await p.query('CREATE DATABASE useraid_practice_review_host_test')}finally{await p.end()}"],cwd=consumer,check=True)
u=urlsplit(os.environ['DATABASE_URL']);env=dict(os.environ,DATABASE_URL=urlunsplit((u.scheme,u.netloc,'/useraid_practice_review_host_test','','')))
for name,args in [('consumer-migrate',['npm','run','migrate']),('consumer',['npm','start'])]:
 with (e/(name+'.log')).open('w') as out:r=subprocess.run(args,cwd=consumer,env=env,stdout=out,stderr=subprocess.STDOUT)
 print(name,r.returncode,flush=True)
 if r.returncode:raise SystemExit(r.returncode)
