import { cookies } from 'next/headers';
import { checkOrigin, cookieOptions, hash, random, requireUser, rateLimit } from '@/lib/auth';
import { db } from '@/lib/db';
import { requireStudioSandbox, sandboxUser, sandboxContribution } from '@/lib/studio-sandbox';
import { failure } from '@/lib/http';
import { sessionCookie } from '@/lib/studio-mode';
export async function POST(request: Request) {
  try {
    requireStudioSandbox();
    checkOrigin(request);
    const body = await request.json();
    if (body.action === 'login') {
      const user = await sandboxUser(
          typeof body.fixtureId === 'string' ? body.fixtureId : undefined,
        ),
        token = random();
      await db.session.create({
        data: {
          userId: user.id,
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + 24 * 3600000),
        },
      });
      (await cookies()).set(sessionCookie(), token, cookieOptions);
    } else {
      const user = await requireUser();
      await rateLimit(`sandbox:${user.id}`, 20, 60);
      await sandboxContribution(String(body.raidId), user.id, body.action === 'complete');
    }
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
