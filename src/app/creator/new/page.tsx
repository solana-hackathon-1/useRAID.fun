import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { notFound } from 'next/navigation';
import { StudioEditor, type StudioDraft } from '@/components/studio-editor';
import { StudioAccess } from '@/components/studio-access';
import { CreatorApproval } from '@/components/creator-approval';
import { balance, usdcSettings } from '@/lib/usdc';
import type { TargetPreview } from '@/lib/studio-targets';
export const dynamic = 'force-dynamic';
export default async function NewRaid({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; path?: string }>;
}) {
  const user = await currentUser();
  if (!user) return <StudioAccess />;
  const { draft, path } = await searchParams;
  const [account, wallet, funds] = await Promise.all([
    db.xAccount.findUnique({ where: { userId: user.id } }),
    db.walletIdentity.findUnique({ where: { userId: user.id } }),
    balance(user.id),
  ]);
  if (!account) return <StudioAccess />;
  if (!user.approved)
    return (
      <div className="studio">
        <h1>Create a Raid</h1>
        <CreatorApproval initial={user.affiliation || ''} />
      </div>
    );
  let initial: StudioDraft | null = null;
  if (draft) {
    const raid = await db.raid.findUnique({
      where: { id: draft },
      include: { briefPosts: { orderBy: { createdAt: 'asc' } } },
    });
    if (
      !raid ||
      raid.creatorId !== user.id ||
      raid.studioVersion !== 1 ||
      raid.status !== 'DRAFT' ||
      raid.hidden
    )
      notFound();
    initial = {
      id: raid.id,
      projectType: raid.mint ? 'TOKEN' : 'PROJECT',
      title: raid.title,
      description: raid.description,
      mint: raid.mint || '',
      name: raid.projectName,
      symbol: raid.projectSymbol,
      imageUri: raid.imageUri || '',
      impressionTarget: raid.impressionTarget!,
      duration: (+raid.endsAt - +raid.startsAt) / 3600000,
      targetPosts: raid.briefPosts.length
        ? raid.briefPosts.map((p) => ({
            url: `https://x.com/i/web/status/${p.postId}`,
            preview: p.preview as TargetPreview | null,
          }))
        : [{ url: '' }],
    };
  }
  return (
    <StudioEditor
      initial={initial}
      path={path === 'token' || path === 'x' ? path : undefined}
      ownerId={user.id}
      walletConnected={!!wallet}
      available={funds.available.toString()}
      rate={usdcSettings().rateUnits?.toString() || null}
    />
  );
}
