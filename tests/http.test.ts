import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { failure, readJson } from '../src/lib/http';
import { HttpError } from '../src/lib/auth-primitives';
import { routeRequest } from './helpers/route';

const schema = z.object({ name: z.string() });
const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });

describe('failure()', () => {
  it('maps SyntaxError and ZodError to 400', async () => {
    expect(failure(new SyntaxError('bad')).status).toBe(400);
    const zod = failure(new ZodError([{ code: 'custom', path: [], message: 'Nope.' }]));
    expect(zod.status).toBe(400);
    expect(await zod.json()).toEqual({ error: 'Nope.' });
  });
  it('maps HttpError to its own status', () => {
    expect(failure(new HttpError(403, 'No.')).status).toBe(403);
  });
  it('maps Prisma not-found, duplicate and validation errors', () => {
    expect(failure(known('P2025')).status).toBe(404);
    expect(failure(known('P2002')).status).toBe(409);
    expect(
      failure(new Prisma.PrismaClientValidationError('bad', { clientVersion: 'test' })).status,
    ).toBe(400);
  });
  it('keeps 503 and logs for anything else', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(failure(new Error('db down')).status).toBe(503);
    expect(failure(known('P1001')).status).toBe(503);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});

describe('readJson()', () => {
  it('returns the parsed object for a valid body', async () => {
    await expect(
      readJson(routeRequest('http://x/', { body: { name: 'a' } }), schema),
    ).resolves.toEqual({
      name: 'a',
    });
  });
  it.each(['null', '[]', '"x"', '{bad json', ''])('rejects body %j with 400', async (rawBody) => {
    const error = await readJson(routeRequest('http://x/', { rawBody }), schema).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });
  it('lets schema failures surface as ZodError, which failure() maps to 400', async () => {
    const error = await readJson(routeRequest('http://x/', { body: { name: 1 } }), schema).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ZodError);
    expect(failure(error).status).toBe(400);
  });
});
