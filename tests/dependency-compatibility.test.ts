import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

function versions(name: string): string[] {
  return Object.entries(lock.packages)
    .filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`)
    .map(([, value]) => (value as { version: string }).version);
}

function atLeast(version: string, floor: string) {
  const actual = version.split('.').map(Number);
  const minimum = floor.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

describe('security repair dependency contracts', () => {
  it.each([
    ['sharp', '0.35.5'],
    ['source-map-js', '1.2.2'],
  ])('clean installs exclude vulnerable %s releases', (name, floor) => {
    expect(versions(name).length).toBeGreaterThan(0);
    expect(
      versions(name).every((version) => atLeast(version, floor)),
      name,
    ).toBe(true);
  });

  it('clean installs exclude vulnerable streaming JSON assemblers', () => {
    expect(versions('stream-json').every((version) => atLeast(version, '3.6.0'))).toBe(true);
  });

  it('the Solana client preserves JSON-RPC request and error handling', async () => {
    const requests: { method: string; id: string; params: unknown[] }[] = [];
    const connection = new Connection('https://rpc.example.invalid', {
      fetch: async (_url, options) => {
        const request = JSON.parse(options!.body as string);
        requests.push(request);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            ...(requests.length === 1
              ? { result: 'test-genesis-hash' }
              : { error: { code: -32000, message: 'fixture RPC denied' } }),
          }),
          { status: 200 },
        );
      },
    });
    expect(await connection.getGenesisHash()).toBe('test-genesis-hash');
    await expect(connection.getGenesisHash()).rejects.toThrow('fixture RPC denied');
    expect(requests.map((request) => request.method)).toEqual(['getGenesisHash', 'getGenesisHash']);
    expect(requests[0].params).toEqual([]);
    expect(requests[0].id).not.toBe(requests[1].id);
  });

  it('the image runtime can decode and resize a raster image', async () => {
    const sharp = require('sharp');
    const input = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    const { info } = await sharp(input).resize(2, 2).png().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.format]).toEqual([2, 2, 'png']);
  });
});
