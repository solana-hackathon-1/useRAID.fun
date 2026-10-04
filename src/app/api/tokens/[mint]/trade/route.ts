import { NextResponse } from 'next/server';
import { checkOrigin,requireUser,rateLimit } from '@/lib/auth';
import { quoteTrade,submitTrade,tradeStatus } from '@/lib/meteora/trading';
import { failure } from '@/lib/http';
export async function POST(request:Request,{params}:{params:Promise<{mint:string}>}) {
  try {checkOrigin(request);const user=await requireUser();await rateLimit(`meteora-trade:${user.id}`,60,60);
    const body=await request.json(),mint=(await params).mint;
    return NextResponse.json(body.action==='submit'?await submitTrade(mint,user.id,body.stepId,body.transaction):await quoteTrade(mint,user.id,body));
  }catch(e){return failure(e);}
}
export async function GET(request:Request,{params}:{params:Promise<{mint:string}>}) {
  try {const user=await requireUser();return NextResponse.json(await tradeStatus((await params).mint,user.id,new URL(request.url).searchParams.get('id')||''),{headers:{'Cache-Control':'private, no-store'}});
  }catch(e){return failure(e);}
}
