/**
 * Finds outbound HTTP calls in TypeScript source text (T091 / blueprint §28.3).
 * - `provider`: the first-argument text of every `providerFetch(` call, which must be a literal pinned https URL.
 * - `raw`: the first-argument text of every bare or `globalThis`/`global`/`self`-qualified `fetch(` call. Server code
 *   may not make any: raw fetch follows redirects, so only providerFetch (redirects refused) may reach a provider.
 * `prefetch(`, `client.fetch(`, `fetchMarket(` and a `function fetch(` declaration are not calls.
 */
const argumentText = (text: string, from: number) => {
  const rest = text.slice(from);
  return rest.match(/^\s*([^\n]{0,120})/)?.[1] ?? '';
};

export function scanOutboundCalls(text: string) {
  const collect = (pattern: RegExp) =>
    [...text.matchAll(pattern)].map((m) => argumentText(text, (m.index ?? 0) + m[0].length));
  return {
    provider: collect(/(?<![\w.$])(?<!function )providerFetch\s*\(/g),
    raw: collect(
      /(?<![\w.$])(?<!function )fetch\s*\(|(?<![\w$])(?:globalThis|global|self)\.fetch\s*\(/g,
    ),
  };
}
