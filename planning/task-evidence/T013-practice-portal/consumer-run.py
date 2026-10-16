import os,subprocess
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit
p=Path(Path('/tmp/raid-t013-practice-portal-consumer-path').read_text());assert p.name.startswith('raid-t013-practice-portal-consumer-') and not (p/'node_modules').is_symlink()
u=urlsplit(os.environ['DATABASE_URL']);assert u.hostname in ['127.0.0.1','localhost'] and u.path=='/useraid_test'
subprocess.run(['docker','exec','raid-t013-practice-portal-auto-20261016','createdb','-U','postgres','useraid_practice_portal_host_test'],check=True)
env=dict(os.environ,DATABASE_URL=urlunsplit((u.scheme,u.netloc,'/useraid_practice_portal_host_test',u.query,u.fragment)))
for cmd in [['npm','run','migrate'],['npm','start']]:subprocess.run(cmd,cwd=p,env=env,check=True)
