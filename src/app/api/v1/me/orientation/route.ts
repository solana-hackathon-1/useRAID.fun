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
const MAX_BYTES = 16384;
class BodyFailure extends Error {
  constructor(readonly status: number) {
    super('INVALID_COMMAND');
  }
}
async function actor() {
  const user = await requireUser();
  const cookie = (await cookies()).get(sessionCookie())?.value;
  if (!cookie) throw new HttpError(401, 'Sign in');
  return { accountId: user.id, actorAccountId: user.id, sessionHash: hash(cookie) };
}
async function input(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new BodyFailure(415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    throw new BodyFailure(Number(length) > MAX_BYTES ? 413 : 422);
  if (!request.body) throw new BodyFailure(422);
  const reader = request.body.getReader();
  let total = 0;
  const parts: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyFailure(408)), 5000);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BYTES) throw new BodyFailure(413);
      parts.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new BodyFailure(422);
    }
    const parsed = SaveRaiderOrientationInputSchema.safeParse(raw);
    if (!parsed.success) throw new BodyFailure(422);
    return parsed.data;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
    const body = await input(request);
    return Response.json(
      await saveOrientation({ actor: authority, input: body, idempotencyKey: key.data, requestId }),
      { headers },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
