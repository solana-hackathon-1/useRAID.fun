from pathlib import Path
import subprocess,shutil,os,json
root=Path('/srv/projects/useRAIDfun/useRAID-fun');dst=Path('/tmp/raid-t008-build-source-2xavo66l')
assert dst.is_dir() and (dst/'node_modules').is_dir() and not (dst/'node_modules').is_symlink()
for raw in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).split(b'\0'):
 if not raw:continue
 rel=Path(os.fsdecode(raw));src=root/rel;target=dst/rel
 if not src.is_file() and not src.is_symlink():continue
 target.parent.mkdir(parents=True,exist_ok=True)
 if src.is_symlink():
  if target.is_symlink():target.unlink()
  elif target.exists():
   if target.is_file():target.unlink()
   elif rel==Path('examples/raider-onboarding/module'):shutil.rmtree(target)
   else:raise RuntimeError('Unexpected owned snapshot path kind: '+str(rel))
  target.symlink_to(src.readlink())
 else:
  if target.is_symlink():target.unlink()
  shutil.copy2(src,target)
env=dict(os.environ,DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:65432/useraid_test',DEMO_MODE='true',APP_URL='http://localhost:3014',NEXT_PUBLIC_APP_URL='http://localhost:3014',USDC_NETWORK='devnet',RAIDER_ONBOARDING_ENABLED='false',WALLET_LINKS_ENABLED='false',ACCOUNT_FOLDS_ENABLED='false',LIVE_COLLECTION_APPROVED='false',LAUNCH_ENABLED='false',PAYOUT_ENABLED='false',X_TRACKING_V2_SETTLEMENT_ENABLED='false')
for name,cmd in [('generate28',['node_modules/.bin/prisma','generate']),('typegen',['node_modules/.bin/next','typegen']),('typecheck',['node_modules/.bin/tsc','--noEmit']),('production-build',['node_modules/.bin/next','build','--webpack'])]:
 print('OWNED SOURCE',dst,'CHECK',name,flush=True)
 with Path('/tmp/raid-t013-practice-storage-'+name+'.log').open('w') as f:subprocess.run(cmd,cwd=dst,env=env,stdout=f,stderr=subprocess.STDOUT,check=True)
 print(name,'PASS',flush=True)
