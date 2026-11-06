/**
 * Outbound provider calls (T091-W03, blueprint §28.3, issue #161).
 *
 * Every server-side request goes to a pinned https provider host (tests/outbound-fetch-allowlist.test.ts). Two further
 * guarantees live here so each call site gets them the same way:
 *  - redirects are refused, so a provider response can never move a bearer credential (X bearer, Pinata JWT, OAuth
 *    client secret) to a host nobody pinned. The caller cannot switch this back on.
 *  - the response body is read through a byte limit and cancelled as soon as it is exceeded, so a misbehaving or
 *    compromised provider cannot make the process buffer an unbounded reply.
 * Timeouts, transport errors and HTTP status handling stay with the caller (its own ProviderError/HttpError semantics).
 */
export type OutboundFetchFailure = 'redirect' | 'too_large' | 'invalid_json' | 'insecure_url';

export class OutboundFetchError extends Error {
  override name = 'OutboundFetchError';
  constructor(
    public readonly code: OutboundFetchFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Ceiling for listing-style replies (X post reads, DexScreener pairs). */
export const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
/** Ceiling for small credential/acknowledgement replies (OAuth token and profile, Pinata upload receipt). */
export const MAX_SMALL_JSON_BYTES = 64 * 1024;

const isRedirectRefusal = (error: unknown) =>
  error instanceof TypeError &&
  /redirect/i.test(String((error.cause as Error | undefined)?.message));

/** Like `fetch` for a literal https provider URL, with redirects always refused. Other rejections pass through. */
export async function providerFetch(
  url: string,
  init: RequestInit = {},
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  if (new URL(url).protocol !== 'https:')
    throw new OutboundFetchError('insecure_url', 'Provider requests must use https.');
  const send = options.fetchImpl ?? globalThis.fetch;
  try {
    return await send(url, { ...init, redirect: 'error' });
  } catch (error) {
    if (isRedirectRefusal(error))
      throw new OutboundFetchError('redirect', 'Provider redirect refused.');
    throw error;
  }
}

/** Parses a JSON reply of at most `maxBytes` (decoded bytes), cancelling the stream once the limit is passed. */
export async function readBoundedJson<T = unknown>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  const tooLarge = () => new OutboundFetchError('too_large', 'Provider response too large.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) throw new OutboundFetchError('invalid_json', 'Provider response was empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    // Release the connection on any failure (oversize, timeout or a broken stream), then rethrow unchanged.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  try {
    // TextDecoder drops a leading UTF-8 byte order mark, exactly as Response.json() does; Buffer#toString would not.
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as T;
  } catch {
    throw new OutboundFetchError('invalid_json', 'Provider response was not valid JSON.');
  }
}
