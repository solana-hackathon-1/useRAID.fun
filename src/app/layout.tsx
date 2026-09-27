import type { Metadata } from 'next';
import './globals.css';
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
      <body>
        <Shell demo={config.demo}>{children}</Shell>
      </body>
    </html>
  );
}
