import { notFound } from 'next/navigation';
import { studioSandbox } from '@/lib/usdc';
import { SandboxControls } from '@/components/studio-sandbox';
import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default function StudioTest() {
  if (!studioSandbox()) notFound();
  return (
    <div className="studio">
      <h1>Test Creator Studio</h1>
      <p>
        <Link href="/test-center">Open the implementation test center →</Link>
      </p>
      <SandboxControls />
    </div>
  );
}
