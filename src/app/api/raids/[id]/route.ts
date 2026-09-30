import { trackingView } from '@/lib/tracking-view';
import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, currentUser, rateLimit } from '@/lib/auth';
import { changeRaid } from '@/lib/campaigns';
import { getRaid } from '@/lib/data';
import { failure } from '@/lib/http';
import { saveStudioRaid, launchStudioRaid } from '@/lib/studio-campaigns';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const raid = await getRaid((await params).id);
    const user = await currentUser();
    const tracking = raid?.trackingVersion === 2 ? await trackingView(raid.id, user?.id) : null;
    return NextResponse.json(raid ? { ...raid, tracking } : { error: 'Raid not found' }, {
      status: raid ? 200 : 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    const body = await request.json();
    const id = (await params).id;
    if (['save', 'fund-launch'].includes(body.action))
      await rateLimit(`studio-mutate:${user.id}`, 30, 60);
    if (body.action === 'save') return NextResponse.json(await saveStudioRaid(user, body, id));
    if (body.action === 'fund-launch')
      return NextResponse.json(
        await launchStudioRaid(
          user,
          id,
          String(body.expectedUnits || ''),
          body.termsAccepted === true,
        ),
      );
    const result = await changeRaid(user, id, body.action);
    return NextResponse.json({ id: result.id, status: result.status });
  } catch (e) {
    return failure(e);
  }
}
