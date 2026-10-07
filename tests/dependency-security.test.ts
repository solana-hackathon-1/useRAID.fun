import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { Connection, PublicKey } from '@solana/web3.js';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { RawSourceMap } from 'source-map-js';

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require('source-map-js') as typeof import('source-map-js');
const web3Require = createRequire(require.resolve('@solana/web3.js'));
const { parseStream } = web3Require('jayson').utils as {
  parseStream: (
    stream: Readable,
    options: Record<string, unknown>,
    callback: (error: Error | null, value?: Record<string, unknown>) => void,
  ) => void;
};

const sectionMap = (line: unknown, column: unknown = 0) =>
  ({
    version: 3,
    sections: [
      {
        offset: { line, column },
        map: { version: 3, sources: ['fixture.ts'], names: [], mappings: 'AAAA' },
      },
    ],
  }) as unknown as RawSourceMap;

function parseChunks(text: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const stream = Readable.from([text.slice(0, 9), text.slice(9, 27), text.slice(27)]);
    parseStream(stream, {}, (error, value) => {
      if (error) reject(error);
      else if (value) resolve(value);
    });
  });
}

describe('installed dependency security boundaries', () => {
  it.each([1_000_000_000, Number.POSITIVE_INFINITY, Number.NaN, 0.5, '10'])(
    'rejects abusive indexed source-map line offsets (%s) before expanding mappings',
    (line) => {
      expect(() => new SourceMapConsumer(sectionMap(line))).toThrow();
    },
  );

  it('still resolves ordinary indexed source-map positions', () => {
    const consumer = new SourceMapConsumer(sectionMap(7));
    expect(consumer.originalPositionFor({ line: 8, column: 1 })).toMatchObject({
      source: 'fixture.ts',
      line: 1,
      column: 0,
    });
  });

  it('ships the native SVG security patch and rasterizes a valid fixture', async () => {
    const native = sharp.versions.rsvg.split('.').map(Number);
    const minimum = [2, 63, 2];
    const difference = native.findIndex((part, index) => part !== minimum[index]);
    expect(difference === -1 || native[difference] > minimum[difference]).toBe(true);
    const image = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#ff0000"/></svg>',
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(image.info).toMatchObject({ width: 1, height: 1, channels: 4 });
    expect([...image.data]).toEqual([255, 0, 0, 255]);
  });

  it('parses chunked RPC JSON without turning prototype keys into inherited authority', async () => {
    const value = await parseChunks(
      '{"__proto__":{"isAdmin":true},"result":{"__proto__":{"paid":true},"amount":"9007199254740993"}}\n',
    );
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.isAdmin).toBeUndefined();
    const result = value.result as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.paid).toBeUndefined();
    expect(result.amount).toBe('9007199254740993');
  });

  it('retains chunked ordinary JSON and reports malformed JSON', async () => {
    expect(await parseChunks('{"jsonrpc":"2.0","id":"fixture-id","result":0}\n')).toEqual({
      jsonrpc: '2.0',
      id: 'fixture-id',
      result: 0,
    });
    await expect(parseChunks('{"result":}\n')).rejects.toBeInstanceOf(Error);
  });
});

describe('Web3.js consuming the installed JSON-RPC client', () => {
  it('preserves endpoint, finality parameters, correlation and a single HTTP dispatch', async () => {
    const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const connection = new Connection('https://rpc.example.invalid', {
      commitment: 'finalized',
      httpAgent: false,
      fetch: async (endpoint, options) => {
        const body = JSON.parse(options?.body as string) as Record<string, unknown>;
        requests.push({ endpoint: String(endpoint), body });
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { context: { slot: 8 }, value: 500 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    expect(await connection.getBalance(new PublicKey('11111111111111111111111111111111'))).toBe(
      500,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].endpoint).toBe('https://rpc.example.invalid');
    expect(requests[0].body).toMatchObject({
      jsonrpc: '2.0',
      method: 'getBalance',
      params: ['11111111111111111111111111111111', { commitment: 'finalized' }],
      id: expect.any(String),
    });
  });

  it('preserves RPC rejection as an error rather than a fabricated balance', async () => {
    const connection = new Connection('https://rpc.example.invalid', {
      httpAgent: false,
      fetch: async (_endpoint, options) => {
        const body = JSON.parse(options?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32000, message: 'fixture denied' },
          }),
          { status: 200 },
        );
      },
    });
    await expect(
      connection.getBalance(new PublicKey('11111111111111111111111111111111')),
    ).rejects.toThrow('fixture denied');
  });
});
