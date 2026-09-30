'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';
import { Plus, ArrowUpRight, Shield, Menu, X } from 'lucide-react';
import { BrandMark } from './brand';
import { StudioAccountMenu, type StudioAccount } from './studio-account-menu';

const links = [
  { href: '/', label: 'Discover' },
  { href: '/creator', label: 'Creator studio' },
  { href: '/launch', label: 'Launchpads · Coming soon' },
  { href: '/methodology', label: 'How it works' },
];
export function Shell({
  children,
  demo,
  account,
  sandbox = false,
}: {
  children: React.ReactNode;
  demo: boolean;
  account?: StudioAccount | null;
  sandbox?: boolean;
}) {
  const path = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header
        className="site-header"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) {
            setMenuOpen(false);
            menuButton.current?.focus();
          }
        }}
      >
        <div className="header-inner">
          <Link
            href="/"
            className="logo"
            aria-label="useRAID.fun home"
            onClick={() => setMenuOpen(false)}
          >
            <span className="logo-mark">
              <BrandMark />
            </span>
            <span>
              use<span className="logo-raid">RAID</span>
              <span className="logo-suffix">.fun</span>
            </span>
          </Link>
          <nav className="desktop-nav" aria-label="Main navigation">
            {links.map(({ href, label }) => (
              <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>
                {label}
              </Link>
            ))}
          </nav>
          <Link
            className="button small header-cta"
            href={account ? '/creator/new' : '/creator'}
            onClick={() => setMenuOpen(false)}
          >
            <Plus size={16} /> Create a raid
          </Link>
          {account && <StudioAccountMenu account={account} />}
          <button
            ref={menuButton}
            className="icon-button menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        <nav
          id="mobile-navigation"
          className="mobile-nav"
          aria-label="Mobile navigation"
          hidden={!menuOpen}
        >
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={path === href ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>
      {demo && (
        <div className="demo-banner">
          <span className="demo-dot" /> Product preview{' '}
          <span className="banner-detail">Example campaigns. Illustrative metrics.</span>
          <Link href="/methodology">
            About the data <ArrowUpRight size={14} />
          </Link>
        </div>
      )}
      {sandbox && (
        <div className="demo-banner">
          Local test Studio · Fixture X posts and test USDC · No real funds{' '}
          <Link href="/creator">Creator Studio</Link>
        </div>
      )}
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer>
        <div className="footer-brand">
          <Link href="/" className="footer-logo">
            <BrandMark /> useRAID.fun
          </Link>
          <span>Community attention, in context.</span>
        </div>
        <div className="footer-links">
          <Link href="/methodology">Methodology</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/admin">
            <Shield size={14} /> Admin
          </Link>
        </div>
      </footer>
    </>
  );
}
