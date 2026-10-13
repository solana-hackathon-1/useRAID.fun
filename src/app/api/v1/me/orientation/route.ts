import { readBoundedJson, JsonBodyFailure as BodyFailure } from '@/http-contracts/json';
import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { checkOrigin, requireUser, rateLimit, hash, HttpError } from '@/lib/auth';
import { sessionCookie } from '@/lib/studio-mode';
import { readOrientationState, saveOrientation } from '@/lib/raider-onboarding-host';
import { InternalId } from '@/contracts/ids';
import { createErrorEnvelope, type ErrorCode } from '@/contracts/protocol';
import { CommandReceiptError } from '@/command-receipts';
import { OnboardingContractError } from '@/raider-onboarding';
import {
  OrientationStorageError,
  SaveRaiderOrientationInputSchema,
} from '@/raider-onboarding/storage-contracts';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
async function actor() {
  const user = await requireUser();
  const cookie = (await cookies()).get(sessionCookie())?.value;
  if (!cookie) throw new HttpError(401, 'Sign in');
  return { accountId: user.id, actorAccountId: user.id, sessionHash: hash(cookie) };
}
function failure(error: unknown, requestId: string) {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  let status: number | undefined;
  if (error instanceof BodyFailure) {
    code = 'INVALID_COMMAND';
    status = error.status;
  } else if (error instanceof HttpError) {
    status = error.status;
    code =
      status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : status === 403
          ? 'FORBIDDEN'
          : status === 429
            ? 'RATE_LIMITED'
            : 'SERVICE_UNAVAILABLE';
  } else if (error instanceof OrientationStorageError) {
    code =
      error.code === 'UNAUTHENTICATED'
        ? 'AUTHENTICATION_REQUIRED'
        : error.code === 'ACCOUNT_RESTRICTED'
          ? 'ACCOUNT_RESTRICTED'
          : error.code === 'WRONG_ACTOR'
            ? 'FORBIDDEN'
            : error.code === 'REVISION_CONFLICT'
              ? 'REVISION_CHANGED'
              : error.code === 'INVALID_INPUT'
                ? 'INVALID_COMMAND'
                : 'SERVICE_UNAVAILABLE';
  } else if (error instanceof OnboardingContractError) {
    code = error.code === 'INVALID_INPUT' ? 'INVALID_COMMAND' : 'SERVICE_UNAVAILABLE';
  } else if (error instanceof CommandReceiptError) {
    code =
      error.code === 'IDEMPOTENCY_KEY_REUSED'
        ? 'IDEMPOTENCY_KEY_REUSED'
        : error.code === 'INVALID_INPUT'
          ? 'INVALID_COMMAND'
          : 'SERVICE_UNAVAILABLE';
  }
  const result = createErrorEnvelope(code, requestId);
  return Response.json(result.body, { status: status ?? result.status, headers });
}
export async function GET() {
  const requestId = randomUUID();
  try {
    return Response.json(await readOrientationState(await actor()), { headers });
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    checkOrigin(request);
    const authority = await actor();
    await rateLimit(`orientation:${authority.accountId}`, 30, 60);
    const key = InternalId.safeParse(request.headers.get('idempotency-key'));
    if (!key.success) throw new BodyFailure(422);
    const parsed = SaveRaiderOrientationInputSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) throw new BodyFailure(422);
    const body = parsed.data;
    return Response.json(
      await saveOrientation({ actor: authority, input: body, idempotencyKey: key.data, requestId }),
      { headers },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
