'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Radio, Compass, Plus, ArrowUpRight, Flame, Shield, BookOpen } from 'lucide-react';
export function Shell({ children, demo }: { children: React.ReactNode; demo: boolean }) {
  const path = usePathname();
  return (
    <>
      <header className="site-header">
        <Link href="/" className="logo">
          <span className="logo-mark">
            <Radio size={24} />
          </span>
          useRAID<span className="logo-suffix">.fun</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/" className={path === '/' ? 'selected' : ''}>
            <Compass size={16} />
            Discover
          </Link>
          <Link href="/creator" className={path.startsWith('/creator') ? 'selected' : ''}>
            <Flame size={16} />
            Creator studio
          </Link>
          <Link href="/methodology" className={path === '/methodology' ? 'selected' : ''}>
            <BookOpen size={16} />
            How it works
          </Link>
        </nav>
        <Link className="button small" href="/creator">
          <Plus size={16} />
          Create a raid
        </Link>
      </header>
      {demo && (
        <div className="demo-banner">
          <span className="demo-dot" />
          Product preview{' '}
          <span className="banner-detail">
            You’re exploring example campaigns. Metrics are illustrative.
          </span>
          <Link href="/methodology">
            About the data <ArrowUpRight size={12} />
          </Link>
        </div>
      )}
      <main>{children}</main>
      <footer>
        <Link href="/" className="footer-logo">
          useRAID.fun
        </Link>
        <span>Community attention, in context.</span>
        <div>
          <Link href="/methodology">Methodology</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/admin">
            <Shield size={13} /> Admin
          </Link>
        </div>
      </footer>
    </>
  );
}
