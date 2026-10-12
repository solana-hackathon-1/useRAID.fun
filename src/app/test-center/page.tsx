import { notFound } from 'next/navigation';
import { config } from '@/lib/config';
import { studioSandbox } from '@/lib/studio-mode';
import { TestCenter } from '@/components/test-center';
import { SandboxControls } from '@/components/studio-sandbox';
import './test-center.css';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Implementation test center',
  robots: { index: false, follow: false },
};

export default function TestCenterPage() {
  const sandbox = studioSandbox();
  if (!config.demo && !sandbox) notFound();
  return <TestCenter sandbox={sandbox}>{sandbox && <SandboxControls />}</TestCenter>;
}
