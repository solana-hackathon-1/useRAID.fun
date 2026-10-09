import pathlib,json,subprocess,os,xml.etree.ElementTree as ET
out=pathlib.Path('/tmp/raid-t006-independent-followup-20261009');root=out/'source';meta=json.loads((out/'environment.json').read_text());name=meta['name']
info=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
assert info['Id']==meta['id'];assert info['Config']['Labels']['raid-task']=='T006-independent-followup';assert info['HostConfig']['Tmpfs'].get('/var/lib/postgresql/data')=='rw,size=512m';assert not any(m['Type']=='volume' for m in info['Mounts'])
env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','TMPDIR','LANG','SHELL']};env.update(DATABASE_URL=(out/'db-url.local').read_text(),RUN_DB_TESTS='true',NODE_ENV='test',DEMO_MODE='false',NEXT_TELEMETRY_DISABLED='1')
checks=[]
def run(label,args,expected=0):
 with (out/(label+'.log')).open('w') as f:r=subprocess.run(args,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
 c={'check':label,'exit':r.returncode,'expected':expected};checks.append(c);(out/'checks.json').write_text(json.dumps(checks,indent=2));print(c,flush=True)
 if r.returncode!=expected:raise RuntimeError(label)
def sql(s):subprocess.run(['docker','exec','-i',name,'psql','-U','useraid','-d','useraid_test','-v','ON_ERROR_STOP=1'],input=s,text=True,check=True,stdout=subprocess.DEVNULL)
def vitest(label,tests=[],pattern=None,red=False):
 args=['npx','vitest','run',*tests,'--reporter=default','--reporter=junit','--outputFile='+str(out/(label+'.xml'))]
 if pattern:args+=['-t',pattern]
 run(label,args,1 if red else 0)
vitest('full-final')
run('tsc',['npx','tsc','--noEmit'])
run('eslint',['npx','eslint','tests/identity-link-db.test.ts'])
run('prettier',['npx','prettier','--check','tests/identity-link-db.test.ts','RAID_AGENT_BLUEPRINT.md','docs/raid-identity-storage.md','docs/raid-wallet-links.md','docs/tasks/T006-wallet-link-plan.md','planning/raid-scenarios.json','planning/raid-task-contracts.json','planning/task-evidence/T006-wallet-links-wip.json'])
run('planning',['python3','-m','unittest','discover','-s','tests','-p','test_raid_*.py'])
run('validator',['python3','scripts/verify-raid-completion.py','T006','planning/task-evidence/T006-contract-verification.json'],1)
