import Link from 'next/link';
import { loadSkillTaxonomyEditor } from '@/lib/skill-taxonomy-page';
import { SkillTaxonomyForm } from '@/components/skill-taxonomy-form';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Skill catalog',
  description: 'Manage stable skill categories and review catalog changes.',
};
export default async function SkillTaxonomyPage() {
  const context = await loadSkillTaxonomyEditor();
  return (
    <div className="studio">
      <h1>Skill catalog</h1>
      {context.status === 'READY' ? (
        <SkillTaxonomyForm state={context.state} />
      ) : context.status === 'SIGN_IN' ? (
        <>
          <p>Sign in with an authorized X account to manage categories.</p>
          <form action="/api/auth/x" method="get">
            <input type="hidden" name="return" value="admin" />
            <button className="button" type="submit">
              Sign in with X
            </button>
          </form>
        </>
      ) : context.status === 'FORBIDDEN' ? (
        <p role="status">Catalog administration is not permitted for this session.</p>
      ) : (
        <p role="status">The configured catalog is currently unavailable. Try again later.</p>
      )}
      <Link className="inline-link" href="/admin">
        Operations
      </Link>
    </div>
  );
}
