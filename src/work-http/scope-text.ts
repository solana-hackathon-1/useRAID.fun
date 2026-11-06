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

const HEADERS = [['Outcome:', 'outcome'], ...LISTS.map(([key, label]) => [label + ':', key])] as [
  string,
  string,
][];
const headerKey = (line: string) => HEADERS.find(([header]) => header === line.trim())?.[1] ?? null;
/**
 * A scope as the text the Founder edits: the labelled outcome and lists for a structured scope (never its JSON),
 * the sentence itself for anything else.
 */
export function scopeToEditable(scope: string): string {
  const readable = readableScope(scope);
  if (!readable) return scope;
  const blocks: string[] = [];
  if (readable.outcome) blocks.push('Outcome:\n' + readable.outcome);
  for (const section of readable.sections)
    blocks.push(section.label + ':\n' + section.items.map((item) => '- ' + item).join('\n'));
  return blocks.join('\n\n');
}
/**
 * The scope to propose from the edited text. Text equal to what `scopeToEditable` showed returns `original`
 * byte for byte, so an untouched field can never alter the stored scope. An edited structured scope is written
 * back in the stored shape; an edited sentence (or an original that was a sentence) is the trimmed text.
 */
export function scopeFromEditable(text: string, original: string): string {
  // Browsers hand textarea text back with \n line ends, whatever the stored text used.
  const lf = (value: string) => value.replace(/\r\n/g, '\n');
  if (lf(text) === lf(scopeToEditable(original))) return original;
  if (!readableScope(original)) return text.trim();
  const parts: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const key = headerKey(line);
    if (key) {
      current = key;
      parts[key] ??= [];
    } else if (current) parts[current].push(line);
    else if (line.trim()) return text.trim();
  }
  if (!current) return text.trim();
  const items = (key: string) => {
    const out: string[] = [];
    let open = false;
    for (const raw of parts[key] ?? []) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('- ') || line === '-' || !open) {
        out.push(line.replace(/^-\s?/, '').trim());
        open = true;
      } else out[out.length - 1] += '\n' + line;
    }
    return out.filter(Boolean);
  };
  const outcome = (parts.outcome ?? []).join('\n').trim();
  const lists = {
    deliverables: items('deliverables'),
    exclusions: items('exclusions'),
    dependencies: items('dependencies'),
  };
  if (!outcome && !Object.values(lists).some((list) => list.length)) return '';
  return JSON.stringify({ outcome, ...lists });
}
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, entry]) => [key, sorted(entry)]),
        )
      : value;
function canonicalScope(scope: string): string {
  const trimmed = scope.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('['))
    try {
      return 'json:' + JSON.stringify(sorted(JSON.parse(trimmed)));
    } catch {
      /* not JSON: compared as the text it is */
    }
  return 'text:' + trimmed;
}
/** Whether two stored scopes mean the same: JSON scopes ignore key order and formatting, text scopes only outer whitespace. */
export const sameScope = (a: string, b: string) => canonicalScope(a) === canonicalScope(b);
