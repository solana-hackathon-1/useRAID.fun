import { Keypair,PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID, DAMM_V2_MIGRATION_FEE_ADDRESS } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk';
import { meteoraReadiness,meteoraConnection,assertMeteoraNetwork } from '../src/lib/meteora/config';
import { db } from '../src/lib/db';
const readiness=meteoraReadiness();
console.log(`Meteora ${readiness.network}: ${readiness.enabled?'launch configuration present':'configuration incomplete'}`);
for(const issue of readiness.issues)console.log(`• ${issue}`);
let key:Keypair|undefined;
try {key=Keypair.fromSecretKey(bs58.decode(process.env.METEORA_OPERATOR_SECRET_KEY || ''));if(key.publicKey.toBase58()!==process.env.METEORA_OPERATOR_PUBLIC_KEY)throw Error();console.log('Worker private/public key: matched');}
catch {console.log('Worker private/public key: missing or mismatch. Configure worker-only environment.');}
if(process.env.METEORA_RPC_URL?.startsWith('https://')) {
  try {
    const rpc=meteoraConnection();await assertMeteoraNetwork(rpc);console.log('RPC network: verified');
    const dfs=new DynamicFeeSharingClient(rpc,'finalized');
    for(const [label,address] of [['DBC',DYNAMIC_BONDING_CURVE_PROGRAM_ID],['DAMM v2',DAMM_V2_PROGRAM_ID],['Fee sharing',dfs.program.programId]] as const) {
      const account=await rpc.getAccountInfo(address,'finalized');console.log(`${label} program: ${account?.executable?'deployed':'unavailable'}`);
    }
    console.log(`DAMM migration config: ${await rpc.getAccountInfo(DAMM_V2_MIGRATION_FEE_ADDRESS[6],'finalized')?'present':'unavailable'}`);
    const address=key?.publicKey || (process.env.METEORA_OPERATOR_PUBLIC_KEY?new PublicKey(process.env.METEORA_OPERATOR_PUBLIC_KEY):null);
    if(address)console.log(`Worker network balance: ${(await rpc.getBalance(address,'finalized')/1e9).toFixed(4)} SOL (minimum 0.05)`);
  }catch {console.log('RPC verification failed. Check endpoint, network and provider availability.');}
}
try {const settings=await db.settings.findUnique({where:{id:'global'}});console.log(`Database: connected; X collection ${settings?.collectionEnabled?'on':'off'}; payouts ${settings?.payoutPaused?'paused':'allowed'}`);}catch {console.log('Database: unavailable. Start PostgreSQL and deploy migrations.');}
await db.$disconnect();
