import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  cleanups: [] as (void | (() => void))[],
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void | (() => void)) => {
    mocks.cleanups.push(effect());
  },
}));
import { AutoRefresh, track } from '../src/components/refresh';

const listeners = new Map<string, () => void>();
const doc = {
  visibilityState: 'visible',
  addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
  removeEventListener: (type: string) => listeners.delete(type),
};
const mount = (props: Parameters<typeof AutoRefresh>[0] = {}) => AutoRefresh(props);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', doc);
  doc.visibilityState = 'visible';
  mocks.refresh.mockClear();
  mocks.cleanups.length = 0;
  listeners.clear();
});
afterEach(() => {
  for (const cleanup of mocks.cleanups) if (cleanup) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('AutoRefresh', () => {
  it('does nothing while inactive', () => {
    mount({ active: false });
    vi.advanceTimersByTime(10 * 60000);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
  it('refreshes roughly once a minute with jitter while visible', () => {
    mount();
    vi.advanceTimersByTime(0.8 * 60000);
    expect(mocks.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0.4 * 60000);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60000 * 1.2);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
  it('skips ticks while hidden and refreshes on return when stale', () => {
    mount({ intervalMs: 1000 });
    doc.visibilityState = 'hidden';
    vi.advanceTimersByTime(5000);
    expect(mocks.refresh).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    listeners.get('visibilitychange')!();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    listeners.get('visibilitychange')!();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it('stops on unmount', () => {
    mount({ intervalMs: 1000 });
    for (const cleanup of mocks.cleanups) if (cleanup) cleanup();
    vi.advanceTimersByTime(10000);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
describe('track', () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };
  beforeEach(() => {
    vi.stubGlobal('localStorage', store());
    vi.stubGlobal('sessionStorage', store());
    vi.stubGlobal('crypto', { randomUUID: () => 'v'.repeat(36) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
  });
  it('sends a view once per tab per half hour, but every click', () => {
    track('discovery_view');
    track('discovery_view');
    track('raid_view', 'r1');
    track('raid_view', 'r2');
    track('share_click', 'r1');
    track('share_click', 'r1');
    expect(fetch).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(31 * 60000);
    track('discovery_view');
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('still sends when storage throws and swallows network failures', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('sessionStorage', broken);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    expect(() => track('raid_view', 'r1')).not.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});
