'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 30000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}
export function track(type: string, raidId?: string) {
  try {
    let visitor = localStorage.getItem('raid_visitor');
    if (!visitor) {
      visitor = crypto.randomUUID();
      localStorage.setItem('raid_visitor', visitor);
    }
    void fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, raidId, visitor }),
      keepalive: true,
    });
  } catch {}
}
