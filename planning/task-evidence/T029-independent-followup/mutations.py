import pathlib,os,sys,subprocess,json,hashlib,xml.etree.ElementTree as E
R=pathlib.Path(__file__).parent;T=sys.argv[1];OUT=R/T;SRC=OUT/'source'
env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','TMPDIR','LANG']};env.update(DATABASE_URL=(OUT/'database-url.txt').read_text().strip(),RUN_DB_TESTS='true',NODE_ENV='test',DEMO_MODE='false')
M={'T029':[
 ('M24','src/asset-registry/registry.ts',"      if (id.kind === 'NATIVE_SOL' && extensions.length > 0)\n        reasons.push('EXTENSIONS_ON_NATIVE_ASSET');","",'tests/asset-registry-registry.test.ts','rejects a native SOL asset whose profile declares any extension'),
 ('M26','src/asset-registry/production.ts',"      if (id.kind === 'TOKEN' && !verifiedPrograms.has(id.tokenProgram as string))\n        add('PROGRAM_NOT_CHAIN_VERIFIED', subject);","",'tests/asset-registry-production.test.ts','blocks a token asset whose token program is not declared chain-verified'),
 ('M30','src/asset-registry/amounts.ts',' || weights.length > MAX_SPLIT_RECIPIENTS','', 'tests/asset-registry-amounts.test.ts','caps the number of recipients at 1024')],
 'T019':[
 ('F03','src/command-receipts/index.ts','insertBindings: [delivery.provider, delivery.verifiedDeliveryId, digest],','insertBindings: [delivery.provider, digest, digest],','tests/command-receipts-db.test.ts','processes two distinct delivery ids that carry identical payloads')]
}
results=[]
for mid,file,old,new,suite,name in M[T]:
 f=SRC/file;pristine=f.read_bytes();text=pristine.decode();assert text.count(old)==1
 mutant=text.replace(old,new)
 if T=='T019':
  old2='lookupBindings: [delivery.provider, delivery.verifiedDeliveryId],';assert mutant.count(old2)==1;mutant=mutant.replace(old2,'lookupBindings: [delivery.provider, digest],')
 try:
  f.write_text(mutant)
  cmd=['npx','vitest','run',suite,'-t',name,'--reporter=default','--reporter=junit','--outputFile='+str(OUT/(mid+'-red.xml'))]
  p=subprocess.run(cmd,cwd=SRC,env=env,capture_output=True,text=True);(OUT/(mid+'-red.log')).write_text(p.stdout+p.stderr)
  x=E.parse(OUT/(mid+'-red.xml')).getroot();fail=[c.attrib['name'] for c in x.findall('.//testcase') if c.find('failure') is not None]
  assert p.returncode==1 and len(fail)==1 and name in fail[0],(p.returncode,fail)
  info={'id':mid,'file':file,'original_sha256':hashlib.sha256(pristine).hexdigest(),'mutant_sha256':hashlib.sha256(mutant.encode()).hexdigest(),'mutation':{'old':old,'new':new},'command':cmd,'exit_code':p.returncode,'junit':x.attrib,'failing_cases':fail,'skipped':len(x.findall('.//skipped'))};results.append(info)
  print(T,mid,'KILLED',fail[0],flush=True)
 finally:
  f.write_bytes(pristine);assert hashlib.sha256(f.read_bytes()).hexdigest()==hashlib.sha256(pristine).hexdigest()
# Run feature slice again on restored source.
suites=['tests/command-receipts.test.ts','tests/command-receipts-db.test.ts','tests/command-receipts-boundary.test.ts'] if T=='T019' else ['tests/asset-registry-amounts.test.ts','tests/asset-registry-boundary.test.ts','tests/asset-registry-bundle.test.ts','tests/asset-registry-db.test.ts','tests/asset-registry-production.test.ts','tests/asset-registry-registry.test.ts']
p=subprocess.run(['npx','vitest','run',*suites,'--reporter=default','--reporter=junit','--outputFile='+str(OUT/'post-mutation-green.xml')],cwd=SRC,env=env,capture_output=True,text=True);(OUT/'post-mutation-green.log').write_text(p.stdout+p.stderr);assert p.returncode==0
(OUT/'mutation-results.json').write_text(json.dumps(results,indent=2)+'\n');print(T,'restored feature GREEN',flush=True)
