import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_LOCK_CLASS,
  ASSESSMENT_LOCK_SQL,
  assessmentLockKey,
} from '../src/skills/assessment-lock';

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

describe('per-person, per-skill assessment lock', () => {
  it('keeps the class, key shape and statement the migrations rely on', () => {
    expect(ASSESSMENT_LOCK_CLASS).toBe(12022);
    expect(assessmentLockKey('person-1', 'frontend')).toBe('person-1:frontend');
    expect(ASSESSMENT_LOCK_SQL).toBe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,12022))::text',
    );
  });
  it('is the only place in src that spells the lock class, so call sites cannot drift', () => {
    const own = join('src', 'skills', 'assessment-lock.ts');
    const copies = sources('src').filter(
      (file) =>
        file !== own && /hashtextextended\([^)]*,\s*12022\)/.test(readFileSync(file, 'utf8')),
    );
    expect(copies).toEqual([]);
  });
});
