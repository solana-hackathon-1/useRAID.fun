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
import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { studioSandbox } from '@/lib/usdc';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { default: 'useRAID.fun — Solana in conversation', template: '%s · useRAID.fun' },
  description:
    'Discover Solana campaigns through measured community attention. Follow the conversation, understand the momentum.',
};
export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const account = user ? await db.xAccount.findUnique({ where: { userId: user.id } }) : null;
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${manrope.variable} ${barlow.variable}`}>
        <Shell
          demo={config.demo}
          sandbox={studioSandbox()}
          account={
            user
              ? {
                  handle: account?.username || user.handle,
                  image: account?.profileImage || null,
                  connected: !!account,
                  admin: user.role === 'ADMIN',
                }
              : null
          }
        >
          {children}
        </Shell>
      </body>
    </html>
  );
}
