import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { HttpError } from './auth';
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
  console.error(error instanceof Error ? error.message : 'Request failed');
  return NextResponse.json({ error: 'Service unavailable. Please try again.' }, { status: 503 });
}
