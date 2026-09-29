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
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { default: 'useRAID.fun — Solana in conversation', template: '%s · useRAID.fun' },
  description:
    'Discover Solana campaigns through measured community attention. Follow the conversation, understand the momentum.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${barlow.variable}`}>
        <Shell demo={config.demo}>{children}</Shell>
      </body>
    </html>
  );
}
