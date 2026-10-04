import { NextResponse } from 'next/server';
import { checkOrigin,requireUser,rateLimit } from '@/lib/auth';
import { prepareCreatorClaim } from '@/lib/meteora/trading';
import { failure } from '@/lib/http';
export async function POST(request:Request,{params}:{params:Promise<{mint:string}>}) {
  try{checkOrigin(request);const user=await requireUser();await rateLimit(`meteora-claim:${user.id}`,10,60);
    return NextResponse.json(await prepareCreatorClaim((await params).mint,user.id));
  }catch(e){return failure(e);}
}
