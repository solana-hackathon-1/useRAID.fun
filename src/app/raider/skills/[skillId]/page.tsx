import Link from 'next/link';
import { SkillClaimForm } from '@/components/skill-claim-form';
import { loadPrivateSkillCatalog } from '@/lib/skill-claims-page';
import { readSkillClaimState } from '@/lib/skill-claims-host';
import { db } from '@/lib/db';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Private skill claim',
  description: 'Record your self-reported experience and private proof links.',
};
export default async function SkillClaimPage({ params }: { params: Promise<{ skillId: string }> }) {
  const context = await loadPrivateSkillCatalog();
  if (context.status === 'SIGN_IN')
    return (
      <div className="studio">
        <h1>Private skill claim</h1>
        <p>Sign in to view your saved claim.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  let loaded:
    | {
        name: string;
        state: Awaited<ReturnType<typeof readSkillClaimState>>;
        participantId: string;
      }
    | undefined;
  if (context.status === 'READY')
    try {
      const { skillId } = await params,
        category = context.taxonomy.skills.find((s) => s.id === skillId);
      const participant = await db.participant.findUnique({
        where: { accountId: context.actor.accountId },
        select: { id: true, kind: true },
      });
      if (category && participant?.kind === 'HUMAN') {
        const state = await readSkillClaimState(context.actor, skillId);
        if (
          !state.claim ||
          (state.claim.participantId === participant.id &&
            state.claim.taxonomyReference.recordId === context.taxonomy.id)
        )
          loaded = { name: category.name, state, participantId: participant.id };
      }
    } catch {
      /* Generic unavailable state never reveals private driver details. */
    }
  return (
    <div className="studio">
      {loaded && context.status === 'READY' ? (
        <>
          <h1>{loaded.name}: private claim</h1>
          <SkillClaimForm
            state={loaded.state}
            catalog={context.taxonomy}
            participantId={loaded.participantId}
          />
        </>
      ) : (
        <>
          <h1>Private skill claim</h1>
          <p role="alert">
            Your claim could not be loaded. Refresh or complete Raider orientation, then try again.
          </p>
        </>
      )}
      <Link className="inline-link" href="/raider/skills">
        Browse skill categories
      </Link>
      <p>
        <Link className="inline-link" href="/raider/onboarding">
          Raider orientation
        </Link>
      </p>
    </div>
  );
}
