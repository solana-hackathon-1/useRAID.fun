// DEC-2026-11-07-01 (d): the web server's request-error hook emits a code plus a safe class and a few fixed
// routing fields, never the error message, the request path/query/headers or a digest-bearing message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestError } from '../src/instrumentation';

const SECRET = 'postgres://admin:HUNTER2-SENTINEL@db.internal:5432/useraid';
const context = {
  routerKind: 'App Router',
  routePath: '/app/api/v1/raids/[id]/route',
  routeType: 'route',
  renderSource: undefined,
  revalidateReason: undefined,
  renderType: undefined,
} as const;

describe('instrumentation onRequestError', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs the event, code, class and fixed routing fields only', async () => {
    const error = Object.assign(new Error(`connect failed ${SECRET}`), { digest: '123456' });
    await onRequestError(
      error,
      { path: `/api/v1/raids/1?token=${SECRET}`, method: 'POST', headers: { cookie: SECRET } },
      context,
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      event: 'request-error',
      method: 'POST',
      routerKind: 'App Router',
      routeType: 'route',
      routePath: '/app/api/v1/raids/[id]/route',
      code: 'UNCLASSIFIED',
      errorClass: 'Error',
    });
    expect(lines[0]).not.toContain('HUNTER2');
    expect(lines[0]).not.toContain('connect failed');
  });
  it('drops routing fields that are not of a fixed shape', async () => {
    await onRequestError(
      new Error('x'),
      { path: '/p', method: SECRET, headers: {} },
      { ...context, routePath: SECRET, routeType: SECRET as never },
    );
    expect(lines[0]).not.toContain('HUNTER2');
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'request-error', code: 'UNCLASSIFIED' });
  });
  it('never throws, even for a hostile thrown value', async () => {
    await expect(
      onRequestError(
        {
          get message(): never {
            throw new Error(SECRET);
          },
        },
        { path: '/p', method: 'GET', headers: {} },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(lines.join('\n')).not.toContain('HUNTER2');
  });
});
