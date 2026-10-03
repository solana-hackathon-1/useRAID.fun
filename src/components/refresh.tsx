'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export function AutoRefresh({
  active = true,
  intervalMs = 60000,
}: {
  active?: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      router.refresh();
    };
    // Jitter keeps viewers who opened the page together from refreshing in lockstep.
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (document.visibilityState === 'visible') refresh();
          schedule();
        },
        intervalMs * (0.85 + Math.random() * 0.3),
      );
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < intervalMs) return;
      clearTimeout(timer);
      refresh();
      schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, intervalMs, router]);
  return null;
}
const TRACK_ONCE_MS = 30 * 60000;
export function track(type: string, raidId?: string) {
  try {
    if (type === 'discovery_view' || type === 'raid_view') {
      const key = `raid_tracked:${type}:${raidId || ''}`;
      try {
        const seen = Number(sessionStorage.getItem(key));
        if (seen && Date.now() - seen < TRACK_ONCE_MS) return;
        sessionStorage.setItem(key, String(Date.now()));
      } catch {}
    }
    let visitor = localStorage.getItem('raid_visitor');
    if (!visitor) {
      visitor = crypto.randomUUID();
      localStorage.setItem('raid_visitor', visitor);
    }
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, raidId, visitor }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
