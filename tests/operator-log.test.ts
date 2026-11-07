// DEC-2026-11-07-01 (d): an operator log line carries a code plus a safe class and never an error message,
// stack, cause or property value. Unit-level contract for the shared helper; the route and worker consumers
// are asserted in http.test.ts, wallet-log-redaction.test.ts and worker-log-redaction-db.test.ts.
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/http';
import { operatorErrorFields, operatorLogLine } from '../src/lib/operator-log';

const SECRET = 'postgres://admin:HUNTER2-SENTINEL@db.internal:5432/useraid';

describe('operatorErrorFields', () => {
  it('returns a code and a class, never the message', () => {
    const fields = operatorErrorFields(new Error(`connect failed ${SECRET}`));
    expect(fields).toEqual({ code: 'UNCLASSIFIED', errorClass: 'Error' });
    expect(JSON.stringify(fields)).not.toContain('HUNTER2');
  });
  it('uses the Prisma error code and class', () => {
    const error = new Prisma.PrismaClientKnownRequestError(`Unique failed on ${SECRET}`, {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(operatorErrorFields(error)).toEqual({
      code: 'P2002',
      errorClass: 'PrismaClientKnownRequestError',
    });
  });
  it('maps an HttpError to its status and a Zod error to VALIDATION', () => {
    expect(operatorErrorFields(new HttpError(403, SECRET))).toEqual({
      code: 'HTTP_403',
      errorClass: 'HttpError',
    });
    expect(operatorErrorFields(new ZodError([]))).toEqual({
      code: 'VALIDATION',
      errorClass: 'ZodError',
    });
  });
  it('keeps a node-style string code and a numeric provider status of safe shape', () => {
    expect(operatorErrorFields(Object.assign(new Error(SECRET), { code: 'ECONNREFUSED' }))).toEqual(
      { code: 'ECONNREFUSED', errorClass: 'Error' },
    );
    expect(operatorErrorFields(Object.assign(new Error(SECRET), { status: 429 })).code).toBe(
      'HTTP_429',
    );
  });
  it('drops a code or class that is not of the safe shape (free text could carry a secret)', () => {
    const hostile = Object.assign(new Error('x'), { code: SECRET, status: 99999 });
    hostile.name = SECRET;
    const fields = operatorErrorFields(hostile);
    expect(fields).toEqual({ code: 'UNCLASSIFIED', errorClass: 'Error' });
    class Sentinel extends Error {}
    Object.defineProperty(Sentinel, 'name', { value: 'bad class with spaces' });
    expect(operatorErrorFields(new Sentinel(SECRET)).errorClass).toBe('Error');
  });
  it('is total: non-Error values, null, cyclic and throwing-getter inputs never throw or leak', () => {
    for (const value of [SECRET, { message: SECRET }, null, undefined, 42, Symbol('s')]) {
      const fields = operatorErrorFields(value);
      expect(fields.code).toBe('UNCLASSIFIED');
      expect(JSON.stringify(fields)).not.toContain('HUNTER2');
    }
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error(SECRET);
        },
      },
    );
    expect(operatorErrorFields(trap)).toEqual({ code: 'UNCLASSIFIED', errorClass: 'Error' });
  });
});

describe('operatorLogLine', () => {
  it('serializes an event plus the safe fields on one JSON line', () => {
    const line = operatorLogLine('request-failed', new Error(SECRET), { step: 'x' });
    expect(JSON.parse(line)).toEqual({
      event: 'request-failed',
      step: 'x',
      code: 'UNCLASSIFIED',
      errorClass: 'Error',
    });
    expect(line).not.toContain('HUNTER2');
  });
});
