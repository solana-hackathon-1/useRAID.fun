export function routeRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  const raw =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (raw !== undefined) headers['content-type'] ??= 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  return new Request(url, {
    method: options.method ?? (raw === undefined ? 'GET' : 'POST'),
    headers,
    body: raw,
  });
}

export const routeContext = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});
