import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboundFetchError, providerFetch, readBoundedJson } from '../src/lib/outbound-fetch';

/**
 * T091-W03 / blueprint §28.3: provider calls refuse redirects (a redirect could carry a bearer credential to a host we
 * never pinned) and bound the response they parse. A local fake stands in for the provider and for the "other host";
 * no real provider is contacted.
 */
type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Server[] = [];
async function listen(handler: Handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
/** Routes the pinned https URL to the local fake, so the real fetch redirect machinery still runs. */
const toLocal =
  (port: number): typeof fetch =>
  (input, init) =>
    fetch(String(input).replace('https://provider.test', `http://127.0.0.1:${port}`), init);

describe('providerFetch redirects', () => {
  let hits: { path: string; authorization?: string }[];
  beforeEach(() => {
    hits = [];
  });
  it('refuses a provider redirect and never contacts the redirect target', async () => {
    const other = await listen((request, response) => {
      hits.push({ path: request.url ?? '', authorization: request.headers.authorization });
      response.end('{}');
    });
    const port = await listen((_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${other}/steal` });
      response.end();
    });
    await expect(
      providerFetch(
        'https://provider.test/v1',
        { headers: { Authorization: 'Bearer secret-jwt' } },
        { fetchImpl: toLocal(port) },
      ),
    ).rejects.toMatchObject({ name: 'OutboundFetchError', code: 'redirect' });
    expect(hits).toEqual([]);
  });
  it('cannot be switched back to following redirects by the caller', async () => {
    const other = await listen((request, response) => {
      hits.push({ path: request.url ?? '' });
      response.end('{}');
    });
    const port = await listen((_request, response) => {
      response.writeHead(307, { Location: `http://127.0.0.1:${other}/x` });
      response.end();
    });
    await expect(
      providerFetch(
        'https://provider.test/v1',
        { redirect: 'follow' },
        { fetchImpl: toLocal(port) },
      ),
    ).rejects.toMatchObject({ code: 'redirect' });
    expect(hits).toEqual([]);
  });
  it('passes a normal response and its credential to the pinned host', async () => {
    let seen: string | undefined;
    const port = await listen((request, response) => {
      seen = request.headers.authorization;
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    const response = await providerFetch(
      'https://provider.test/v1',
      { headers: { Authorization: 'Bearer secret-jwt' } },
      { fetchImpl: toLocal(port) },
    );
    expect(seen).toBe('Bearer secret-jwt');
    expect(await readBoundedJson(response, 1024)).toEqual({ ok: true });
  });
  it('leaves timeouts and transport failures untouched for the caller', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    await expect(
      providerFetch(
        'https://provider.test/v1',
        {},
        { fetchImpl: async () => Promise.reject(timeout) },
      ),
    ).rejects.toBe(timeout);
    const transport = new TypeError('fetch failed');
    await expect(
      providerFetch(
        'https://provider.test/v1',
        {},
        { fetchImpl: async () => Promise.reject(transport) },
      ),
    ).rejects.toBe(transport);
  });
  it('rejects a non-https URL before sending anything', async () => {
    let called = false;
    await expect(
      providerFetch(
        'http://api.x.com/2/tweets',
        {},
        {
          fetchImpl: async () => {
            called = true;
            return new Response('{}');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    expect(called).toBe(false);
  });
});

describe('readBoundedJson size limit', () => {
  it('refuses an endless body without buffering it', async () => {
    let written = 0;
    const port = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json');
      const chunk = Buffer.alloc(16 * 1024, 0x20);
      const pump = () => {
        while (written < 512 * 1024 * 1024) {
          written += chunk.length;
          if (!response.write(chunk)) return void response.once('drain', pump);
        }
      };
      pump();
    });
    const response = await providerFetch(
      'https://provider.test/v1',
      {},
      { fetchImpl: toLocal(port) },
    );
    await expect(readBoundedJson(response, 64 * 1024)).rejects.toMatchObject({
      name: 'OutboundFetchError',
      code: 'too_large',
    });
    // Backpressure plus cancel: the server never got to push anything near the 512 MiB it was willing to send.
    expect(written).toBeLessThan(32 * 1024 * 1024);
  });
  it('refuses a declared oversize body before reading any of it', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(10));
      },
    });
    const response = new Response(body, { headers: { 'content-length': '5000000' } });
    await expect(readBoundedJson(response, 1024)).rejects.toMatchObject({ code: 'too_large' });
    expect(pulls).toBeLessThanOrEqual(1);
  });
  it('stops pulling once an undeclared stream passes the limit', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(512));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(readBoundedJson(new Response(body), 1024)).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(pulls).toBeLessThanOrEqual(4);
    expect(cancelled).toBe(true);
  });
  it('accepts a body exactly at the limit and rejects one byte over', async () => {
    const exact = JSON.stringify({ v: 'x'.repeat(100) });
    const size = Buffer.byteLength(exact);
    expect(await readBoundedJson(new Response(exact), size)).toEqual({ v: 'x'.repeat(100) });
    await expect(readBoundedJson(new Response(exact), size - 1)).rejects.toMatchObject({
      code: 'too_large',
    });
  });
  it('counts bytes, not characters', async () => {
    const text = JSON.stringify({ v: '€'.repeat(40) }); // 3 bytes per character
    await expect(readBoundedJson(new Response(text), 60)).rejects.toMatchObject({
      code: 'too_large',
    });
  });
  it('reports malformed JSON and a missing body as typed failures', async () => {
    await expect(readBoundedJson(new Response('<html>'), 1024)).rejects.toMatchObject({
      code: 'invalid_json',
    });
    await expect(readBoundedJson(new Response(null), 1024)).rejects.toBeInstanceOf(
      OutboundFetchError,
    );
  });
});

describe('readBoundedJson reader cleanup', () => {
  it('cancels the reader and rethrows unchanged when a read fails', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw timeout;
      },
    });
    const response = new Response(body);
    const reader = response.body!.getReader();
    const cancel = vi.spyOn(reader, 'cancel');
    vi.spyOn(response.body!, 'getReader').mockReturnValue(reader);
    await expect(readBoundedJson(response, 1024)).rejects.toBe(timeout);
    expect(cancel).toHaveBeenCalled();
  });
});
