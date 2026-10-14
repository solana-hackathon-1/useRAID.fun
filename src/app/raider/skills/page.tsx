import Link from 'next/link';
import { loadPrivateSkillCatalog } from '@/lib/skill-claims-page';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Private skill claims',
  description: 'Record your self-reported experience and private proof links.',
};
export default async function SkillCatalogPage() {
  const context = await loadPrivateSkillCatalog();
  if (context.status === 'SIGN_IN')
    return (
      <div className="studio">
        <h1>Private skill claims</h1>
        <p>Sign in to view your skills.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  if (context.status !== 'READY')
    return (
      <div className="studio">
        <h1>Private skill claims</h1>
        <p role="status">The skill catalog is currently unavailable. Try again later.</p>
        <Link className="inline-link" href="/raider/onboarding">
          Raider orientation
        </Link>
      </div>
    );
  const skills = context.taxonomy.skills.filter((s) => s.status === 'ACTIVE');
  return (
    <div className="studio">
      <h1>Private skill claims</h1>
      <p>
        Choose a skill to record self-reported experience and optional private proof links. Claims
        do not verify a rank.
      </p>
      {skills.length ? (
        <ul>
          {skills.map((s) => (
            <li key={s.id}>
              <Link className="inline-link" href={'/raider/skills/' + encodeURIComponent(s.id)}>
                {s.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>No active skill categories are available.</p>
      )}
      <Link className="inline-link" href="/raider/onboarding">
        Raider orientation
      </Link>
    </div>
  );
}
