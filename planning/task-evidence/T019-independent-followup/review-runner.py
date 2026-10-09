import pathlib,os,sys,subprocess,json,hashlib,xml.etree.ElementTree as ET
BASE=pathlib.Path(__file__).parent
T=sys.argv[1];PHASE=sys.argv[2];OUT=BASE/T;SRC=OUT/'source'
ENV={k:v for k,v in os.environ.items() if k in ['PATH','HOME','TMPDIR','LANG']}
ENV.update(DATABASE_URL=(OUT/'database-url.txt').read_text().strip(),RUN_DB_TESTS='true',NODE_ENV='test',DEMO_MODE='false',NEXT_TELEMETRY_DISABLED='1')
FEATURE={'T019':['tests/command-receipts.test.ts','tests/command-receipts-db.test.ts','tests/command-receipts-boundary.test.ts'],'T029':['tests/asset-registry-amounts.test.ts','tests/asset-registry-boundary.test.ts','tests/asset-registry-bundle.test.ts','tests/asset-registry-db.test.ts','tests/asset-registry-production.test.ts','tests/asset-registry-registry.test.ts']}
RESULTS=[]
def run(label,args,expect=0):
 p=subprocess.run(args,cwd=SRC,env=ENV,capture_output=True,text=True);(OUT/(label+'.log')).write_text(p.stdout+p.stderr)
 info={'label':label,'command':' '.join(args),'exit_code':p.returncode,'expected_exit_code':expect};RESULTS.append(info)
 print(T,label,'exit',p.returncode,flush=True)
 assert p.returncode==expect,info
 return p
if PHASE=='setup':
 run('generate',['npx','prisma','generate'])
 run('migrate-first',['npx','prisma','migrate','deploy'])
 run('migrate-repeat',['npx','prisma','migrate','deploy'])
 # URL is not placed in the evidence command; no credentials in output summary.
 p=subprocess.run(['npx','prisma','migrate','diff','--from-url',ENV['DATABASE_URL'],'--to-schema-datamodel','prisma/schema.prisma','--exit-code'],cwd=SRC,env=ENV,capture_output=True,text=True)
 (OUT/'drift.log').write_text(p.stdout+p.stderr);RESULTS.append({'label':'drift','command':'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code','exit_code':p.returncode});assert p.returncode==0
elif PHASE in ['feature','full']:
 run(PHASE,['npx','vitest','run']+(FEATURE[T] if PHASE=='feature' else [])+['--reporter=default','--reporter=junit','--outputFile='+str(OUT/(PHASE+'.xml'))])
elif PHASE=='static':
 run('validator',['python3','scripts/verify-raid-completion.py',T,'planning/task-evidence/'+T+'.json'],1 if T=='T029' else 0)
 run('planning',['python3','-m','unittest','discover','-s','tests','-p','test_raid_*.py'])
 run('typecheck',['npm','run','typecheck'])
 run('format',['npm','run','format:check'])
(OUT/(PHASE+'-commands.json')).write_text(json.dumps(RESULTS,indent=2)+'\n')
