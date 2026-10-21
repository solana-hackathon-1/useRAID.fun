import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/lib/skill-claims-page', () => ({ loadPrivateSkillCatalog: mocks.load }));
import SkillCatalogPage from '../src/app/raider/skills/page';
const ready = {
  status: 'READY',
  taxonomy: {
    skills: [{ id: 'frontend', name: 'Frontend', domain: 'web', status: 'ACTIVE', aliases: [] }],
  },
};
beforeEach(() => vi.resetAllMocks());
it('links signed-in Raiders from the skill catalog to unpaid practice without claiming a rank', async () => {
  mocks.load.mockResolvedValue(ready);
  const html = renderToStaticMarkup(await SkillCatalogPage());
  expect(html).toContain('href="/raider/practice"');
  expect(html).toContain('Practice trials');
  expect(html).toContain('do not verify a rank');
});
it('offers the practice link when the catalog is unavailable, since practice has its own gate', async () => {
  mocks.load.mockResolvedValue({ status: 'UNAVAILABLE' });
  const html = renderToStaticMarkup(await SkillCatalogPage());
  expect(html).toContain('href="/raider/practice"');
});
it('does not show the link to signed-out visitors', async () => {
  mocks.load.mockResolvedValue({ status: 'SIGN_IN' });
  const html = renderToStaticMarkup(await SkillCatalogPage());
  expect(html).not.toContain('/raider/practice');
});
