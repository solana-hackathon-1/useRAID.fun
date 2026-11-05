/** A stored scope shown as text: the outcome plus labelled lists, never the JSON it is stored as. */
export interface ReadableScope {
  outcome: string | null;
  sections: { label: string; items: string[] }[];
}
const LISTS = [
  ['deliverables', 'Deliverables'],
  ['exclusions', 'Not included'],
  ['dependencies', 'Depends on'],
] as const;
const KEYS = new Set<string>(['outcome', ...LISTS.map(([key]) => key)]);
const isTexts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
/**
 * Accepted terms keep their scope as the JSON of `{ outcome, deliverables, exclusions, dependencies }`, while a
 * Founder-written scope is a plain sentence. Returns the readable parts for the first kind and null for anything
 * else, so a plain or unexpected scope is always shown exactly as written. Only text is returned, never markup.
 */
export function readableScope(scope: string): ReadableScope | null {
  const trimmed = scope.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const names = Object.keys(record);
  if (names.length === 0 || names.some((name) => !KEYS.has(name))) return null;
  if ('outcome' in record && typeof record.outcome !== 'string') return null;
  if (LISTS.some(([key]) => key in record && !isTexts(record[key]))) return null;
  const outcome = typeof record.outcome === 'string' && record.outcome ? record.outcome : null;
  const sections = LISTS.flatMap(([key, label]) => {
    const items = (record[key] as string[] | undefined) ?? [];
    return items.length ? [{ label, items }] : [];
  });
  return outcome || sections.length ? { outcome, sections } : null;
}
