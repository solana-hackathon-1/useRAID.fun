const MAX_BYTES = 16384;
export class JsonBodyFailure extends Error {
  constructor(readonly status: number) {
    super('INVALID_COMMAND');
  }
}
export async function readBoundedJson(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new JsonBodyFailure(415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    throw new JsonBodyFailure(Number(length) > MAX_BYTES ? 413 : 422);
  if (!request.body) throw new JsonBodyFailure(422);
  const reader = request.body.getReader();
  let total = 0;
  const parts: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JsonBodyFailure(408)), 5000);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BYTES) throw new JsonBodyFailure(413);
      parts.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new JsonBodyFailure(422);
    }
    return raw;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
