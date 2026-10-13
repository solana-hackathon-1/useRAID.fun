import { GuildDraftPage } from '@/components/guild-draft-page';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Private Guild draft' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <GuildDraftPage id={(await params).id} />;
}
