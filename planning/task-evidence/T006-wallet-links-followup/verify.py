import subprocess, os, json, pathlib, urllib.parse
root=pathlib.Path('/Users/dushyant/Documents/useRAID.fun/.claude/worktrees/agent-a72bd54d2c22fff89')
out=pathlib.Path('/tmp/raid-t006-codex-lr')
info=json.loads(subprocess.check_output(['docker','inspect','raid-t006-links-db']))[0]
assert info['Id']=='f40d42425c19302cba45504116d8aa9c48024285d6a3aa73047191f51a0ab74c'
config=dict(x.split('=',1) for x in info['Config']['Env'])
env=os.environ.copy();env.update(RUN_DB_TESTS='true',NODE_ENV='test',DEMO_MODE='false')
env['DATABASE_URL']='postgresql://'+urllib.parse.quote(config['POSTGRES_USER'],safe='')+':'+urllib.parse.quote(config['POSTGRES_PASSWORD'],safe='')+'@127.0.0.1:56904/useraid_test'
def sql(statement):
 subprocess.run(['docker','exec','-i','raid-t006-links-db','psql','-U',config['POSTGRES_USER'],'-d','useraid_test','-v','ON_ERROR_STOP=1'],input=statement,text=True,check=True,stdout=subprocess.DEVNULL)
def run(name,tests,pattern=None):
 args=['npx','vitest','run',*tests]
 if pattern: args+=['-t',pattern]
 args+=['--reporter=default','--reporter=junit','--outputFile='+str(out/(name+'.xml'))]
 with (out/(name+'.log')).open('w') as log:
  result=subprocess.run(args,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 print(name,'exit',result.returncode,flush=True)
 return result.returncode
mode=os.sys.argv[1]
if mode=='mutants':
 try:
  sql("""DROP INDEX "WalletLink_address_key"; CREATE UNIQUE INDEX "WalletLink_address_key" ON "WalletLink" (address) WHERE status='ACTIVE';""")
  assert run('lr01-D2-red',['tests/identity-link-db.test.ts'],'catalog contains|raw SQL cannot reassign')!=0
 finally: sql('DROP INDEX IF EXISTS "WalletLink_address_key"; CREATE UNIQUE INDEX "WalletLink_address_key" ON "WalletLink" (address);')
 try:
  sql('DROP TRIGGER wallet_link_subject_exclusive_v1 ON "WalletLink";')
  assert run('lr02-D6-red',['tests/identity-link-db.test.ts'],'raw SQL cannot link an existing primary')!=0
 finally: sql('CREATE TRIGGER wallet_link_subject_exclusive_v1 BEFORE INSERT ON "WalletLink" FOR EACH ROW EXECUTE FUNCTION raid_wallet_subject_exclusive_v1();')
 assert run('lr01-lr02-green',['tests/identity-link-db.test.ts'],'catalog contains|raw SQL cannot')==0
elif mode=='feature':
 assert run('feature-green',['tests/identity-link.test.ts','tests/identity-link-db.test.ts','tests/identity-link-migration.test.ts','tests/identity-link-boundary.test.ts','tests/wallet-link-proof.test.ts'])==0
elif mode=='full':
 assert run('full-refactor',[])==0
