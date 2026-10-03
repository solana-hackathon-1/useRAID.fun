'use client';
import { useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown } from 'lucide-react';
export type StudioAccount = {
  handle: string;
  image: string | null;
  connected: boolean;
  admin: boolean;
};
export function StudioAccountMenu({ account }: { account: StudioAccount }) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const button = useRef<HTMLButtonElement>(null),
    router = useRouter();
  async function action(path: string) {
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error);
      setOpen(false);
      router.push('/creator');
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="studio-account-menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        className="studio-account-trigger"
        ref={button}
        aria-expanded={open}
        aria-controls="studio-account-dropdown"
        onClick={() => setOpen(!open)}
      >
        {account.image && (
          <img src={account.image} alt="" referrerPolicy="no-referrer" loading="lazy" />
        )}
        <span>@{account.handle}</span>
        {account.connected && <Check size={15} aria-label="X connected" />}
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <button
            className="studio-menu-backdrop"
            aria-label="Close account menu"
            onClick={() => setOpen(false)}
          />
          <div id="studio-account-dropdown" className="studio-account-dropdown">
            <Link href="/creator/account" onClick={() => setOpen(false)}>
              Account
            </Link>
            <Link href="/creator/balance" onClick={() => setOpen(false)}>
              Balance
            </Link>
            {account.admin && (
              <Link href="/admin" onClick={() => setOpen(false)}>
                Operations
              </Link>
            )}
            {account.connected && (
              <button disabled={busy} onClick={() => void action('/api/auth/x/disconnect')}>
                Disconnect X
              </button>
            )}
            <button disabled={busy} onClick={() => void action('/api/auth/logout')}>
              Sign out
            </button>
            {message && <p role="alert">{message}</p>}
          </div>
        </>
      )}
    </div>
  );
}
