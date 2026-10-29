import type { Metadata } from 'next';
import './globals.css';
import localFont from 'next/font/local';
const manrope = localFont({
  src: './fonts/Manrope-Variable.ttf',
  variable: '--font-body',
  display: 'swap',
  weight: '200 800',
});
const barlow = localFont({
  src: './fonts/BarlowCondensed-Bold.ttf',
  variable: '--font-display',
  display: 'swap',
  weight: '700',
});
import { Shell } from '@/components/shell';
import { config } from '@/lib/config';
import { shellAccount } from '@/lib/shell-account';
import { publicNavLinks } from '@/lib/work-entry-links';
import { loadActiveRaid } from '@/lib/work-workspace-page';
import { studioSandbox } from '@/lib/usdc';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { default: 'useRAID.fun — Solana in conversation', template: '%s · useRAID.fun' },
  description:
    'Discover Solana campaigns through measured community attention. Follow the conversation, understand the momentum.',
};
export default async function Layout({ children }: { children: React.ReactNode }) {
  // Per-request and session-bound (force-dynamic → private, no-store): never part of a cached public page.
  const [account, activeRaid] = await Promise.all([shellAccount(), loadActiveRaid()]);
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${manrope.variable} ${barlow.variable}`}>
        <Shell
          demo={config.demo}
          sandbox={studioSandbox()}
          account={account}
          extraLinks={publicNavLinks()}
          activeRaid={account ? activeRaid : null}
        >
          {children}
        </Shell>
      </body>
    </html>
  );
}
