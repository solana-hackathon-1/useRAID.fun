import { FLAG_CATALOG } from './flags';

/**
 * Pure flag snapshot for the configuration-change audit (DEC-2026-11-13-01, T037-W03). It reads only the record it
 * is given. Only flag NAMES and a closed four-word value are ever produced: a flag value that is not exactly `true`
 * or `false` becomes `invalid`, so no other environment text (secret or not) can reach the audit.
 */
export type FlagValue = 'true' | 'false' | 'unset' | 'invalid';
export type FlagSnapshot = Readonly<Record<string, FlagValue>>;
export interface FlagChange {
  readonly flag: string;
  readonly previous: FlagValue | null;
  readonly next: FlagValue;
  /** A baseline observation is not a change (the first start of an environment and process kind). */
  readonly kind: 'INITIAL_OBSERVATION' | 'CHANGE';
}

const FLAG_NAME = /^[A-Z][A-Z0-9_]{0,99}_(ENABLED|APPROVED)$/;

const valueOf = (raw: string | undefined): FlagValue =>
  raw === undefined || raw === '' ? 'unset' : raw === 'true' || raw === 'false' ? raw : 'invalid';

/**
 * The catalogued switches plus any `*_ENABLED`/`*_APPROVED` variable in a catalogued family (the validator's own
 * "known" rule, so ambient operating-system variables are not recorded).
 */
export function flagSnapshot(env: Readonly<Record<string, string | undefined>>): FlagSnapshot {
  const out: Record<string, FlagValue> = {};
  for (const flag of FLAG_CATALOG) out[flag.name] = valueOf(env[flag.name]);
  const families = new Set(FLAG_CATALOG.map((flag) => flag.name.split('_')[0]));
  for (const name of Object.keys(env).sort())
    if (!(name in out) && FLAG_NAME.test(name) && families.has(name.split('_')[0]))
      out[name] = valueOf(env[name]);
  return Object.freeze(out);
}

/**
 * `previous === null` means no snapshot was ever recorded for this environment and process kind: everything is a
 * baseline observation. A flag first seen after the baseline is a change unless it is simply `unset`.
 */
export function diffFlagSnapshots(
  previous: FlagSnapshot | null,
  next: FlagSnapshot,
): readonly FlagChange[] {
  const changes: FlagChange[] = [];
  const names = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(next)])].sort();
  for (const flag of names) {
    const after: FlagValue = next[flag] ?? 'unset';
    if (previous === null) {
      changes.push({ flag, previous: null, next: after, kind: 'INITIAL_OBSERVATION' });
      continue;
    }
    const before = previous[flag];
    if (before === undefined)
      changes.push({
        flag,
        previous: null,
        next: after,
        kind: after === 'unset' ? 'INITIAL_OBSERVATION' : 'CHANGE',
      });
    else if (before !== after)
      changes.push({ flag, previous: before, next: after, kind: 'CHANGE' });
  }
  return changes;
}
