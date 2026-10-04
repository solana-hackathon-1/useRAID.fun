import { config as loadEnv } from 'dotenv';
import { spawn, spawnSync } from 'node:child_process';
loadEnv({path:'.env.local',quiet:true}); loadEnv({quiet:true});
const database = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['localhost','127.0.0.1'].includes(database.hostname)) throw Error('Devnet runner requires local PostgreSQL.');
const mode = process.argv[2] || 'web';
if (mode==='worker'||mode==='doctor') loadEnv({path:'.env.meteora.worker',override:true,quiet:true});
database.pathname = mode==='test'?'/useraid_meteora_test':'/useraid_meteora_devnet';
if (!['web','worker','migrate','test','doctor'].includes(mode)) throw Error('Choose web, worker, migrate, test or doctor.');
const env = {...process.env, DATABASE_URL:database.toString(),METEORA_NETWORK:'devnet',STUDIO_SANDBOX:'false',DEMO_MODE:'false',
  NEXT_DIST_DIR:'.next-meteora',NEXT_PUBLIC_APP_URL:process.env.METEORA_DEVNET_APP_URL || 'http://localhost:3008',
  APP_URL:process.env.METEORA_DEVNET_APP_URL || 'http://localhost:3008',RUN_METEORA_DB_TESTS:mode==='test'?'true':undefined};
if(mode==='migrate'||mode==='test') {
  const name=mode==='test'?'useraid_meteora_test':'useraid_meteora_devnet';
  const probe=spawnSync('docker',['compose','exec','-T','db','psql','-U','useraid','-d','postgres','-Atc',`SELECT 1 FROM pg_database WHERE datname='${name}'`],{encoding:'utf8'});
  if(probe.status!==0)throw Error('Start local database first.');
  if(!probe.stdout.trim()&&spawnSync('docker',['compose','exec','-T','db','createdb','-U','useraid',name],{stdio:'inherit'}).status!==0)throw Error('Cannot create isolated database.');
  if(mode==='test'&&spawnSync('npx',['prisma','migrate','deploy'],{env,stdio:'inherit'}).status!==0)throw Error('Test migrations failed.');
}
const args=mode==='doctor'?['tsx','scripts/meteora-doctor.ts']:mode==='worker'?['tsx','src/worker.ts']:mode==='migrate'?['prisma','migrate','deploy']:mode==='test'?['vitest','run','tests/meteora-db.test.ts']:['next','dev','--hostname','127.0.0.1','--port','3008'];
const child=spawn('npx',args,{env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code || 0));
