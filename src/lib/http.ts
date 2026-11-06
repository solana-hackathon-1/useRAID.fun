import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError, type ZodType } from 'zod';
import { HttpError } from './auth-primitives';
/** Default ceiling for a JSON command body. Every legacy command is a few short fields. */
export const JSON_BODY_MAX_BYTES = 64 * 1024;
/**
 * Reads a request body only up to `maxBytes`. A declared oversize length is refused before any byte is read; an
 * undeclared (chunked) body is cancelled the moment it passes the ceiling, so a caller cannot make the process hold an
 * arbitrarily large request however small the later schema or file-size check is.
 */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    throw new HttpError(413, 'Request body too large.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'Request body too large.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
/**
 * A JSON object body, bounded before it is parsed. Anything that is not a JSON object is a 400. Untyped like
 * `request.json()`, which it replaces: each route validates the fields it reads.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonBody(request: Request, maxBytes = JSON_BODY_MAX_BYTES): Promise<any> {
  const bytes = await readBodyBytes(request, maxBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid request body.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'Invalid request body.');
  return raw;
}
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  return schema.parse(await readJsonBody(request));
}
export function failure(error: unknown) {
  if (error instanceof HttpError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError)
    return NextResponse.json(
      { error: error.issues.map((i) => i.message).join(' ') },
      { status: 400 },
    );
  if (error instanceof SyntaxError)
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    return NextResponse.json({ error: 'Already exists.' }, { status: 409 });
  if (error instanceof Prisma.PrismaClientValidationError)
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  console.error(error instanceof Error ? error.message : 'Request failed');
  return NextResponse.json({ error: 'Service unavailable. Please try again.' }, { status: 503 });
}
