import { describe, expect, it } from 'vitest';
import {
  correlationFields,
  jobCorrelationId,
  withCorrelation,
} from '../src/lib/worker-diagnostics';

describe('job correlation ids (T038 W03)', () => {
  it('keeps a normal job id readable', () => {
    expect(jobCorrelationId('cmabc123def456')).toBe('job-cmabc123def456');
  });

  it.each([
    ['a uuid inserted by raw SQL', '3f2b8c1e-7a4d-4f6a-9b1c-2d3e4f5a6b7c'],
    ['text that could carry a secret', 'token sk-live-123 in provider body'],
    ['an over-long id', 'x'.repeat(200)],
    ['a line break', 'abc\ninjected'],
  ])('still runs the job for %s, without the id reaching the log', async (_name, id) => {
    let ran = false;
    await withCorrelation(jobCorrelationId(id), async () => {
      ran = true;
      expect(correlationFields().correlationId).toMatch(/^job-[0-9a-f]{24}$/);
      expect(correlationFields().correlationId).not.toContain(id);
    });
    expect(ran).toBe(true);
  });

  it('gives every attempt of one job the same id', () => {
    const id = '3f2b8c1e-7a4d-4f6a-9b1c-2d3e4f5a6b7c';
    expect(jobCorrelationId(id)).toBe(jobCorrelationId(id));
    expect(jobCorrelationId(id)).not.toBe(jobCorrelationId(`${id}0`));
  });
});
