import os,subprocess,json
from pathlib import Path
p=Path(Path('/tmp/raid-t013-review-policies-consumer-path').read_text());assert p.name.startswith('raid-t013-review-policies-consumer-') and not (p/'node_modules').is_symlink()
from urllib.parse import urlsplit,urlunsplit
u=urlsplit(os.environ['DATABASE_URL']);assert u.hostname in ['127.0.0.1','localhost'] and u.path=='/useraid_test'
subprocess.run(['docker','exec','raid-t013-review-policies-auto-20261015','createdb','-U','postgres','useraid_practice_review_policy_host_test'],check=True)
env=dict(os.environ,DATABASE_URL=urlunsplit((u.scheme,u.netloc,'/useraid_practice_review_policy_host_test',u.query,u.fragment)))
for cmd in [['npm','run','migrate'],['npm','start']]:subprocess.run(cmd,cwd=p,env=env,check=True)
