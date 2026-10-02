import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError, type ZodType } from 'zod';
import { HttpError } from './auth-primitives';
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, 'Invalid request body.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpError(400, 'Invalid request body.');
  return schema.parse(raw);
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
