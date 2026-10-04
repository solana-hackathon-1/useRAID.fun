import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { meteoraTokenView } from '@/lib/meteora/view';
import { failure } from '@/lib/http';
export async function GET(_:Request,{params}:{params:Promise<{mint:string}>}) {
  try{const user=await currentUser();const view=await meteoraTokenView((await params).mint,user?.id,true);
    return NextResponse.json(view||{error:'Launch not found.'},{status:view?200:404,headers:{'Cache-Control':'private, no-store'}});
  }catch(e){return failure(e);}
}
