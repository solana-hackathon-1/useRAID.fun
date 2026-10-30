import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/data', () => ({ getRaids: async () => [] }));
vi.mock('@/components/discovery', () => ({ Discovery: () => null }));
import Home from '../src/app/page';
import { publicNavLinks } from '../src/lib/work-entry-links';

const original = process.env.GUILD_PUBLIC_READS_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
  else process.env.GUILD_PUBLIC_READS_ENABLED = original;
});
const html = async () => renderToStaticMarkup(await Home());

describe('T015 homepage Guild entry point', () => {
  it.each([undefined, '', 'TRUE', '1', 'true '])(
    'advertises nothing while the Guild flag is %j',
    async (flag) => {
      if (flag === undefined) delete process.env.GUILD_PUBLIC_READS_ENABLED;
      else process.env.GUILD_PUBLIC_READS_ENABLED = flag;
      expect(await html()).not.toContain('/guilds');
      expect(publicNavLinks().some((link) => link.href === '/guilds')).toBe(false);
    },
  );
  it('links to the Guild directory from the page and the main navigation only while the flag is exactly "true"', async () => {
    process.env.GUILD_PUBLIC_READS_ENABLED = 'true';
    const out = await html();
    expect(out).toContain('href="/guilds"');
    expect(out).toContain('aria-label="Guilds"');
    expect(publicNavLinks()).toContainEqual({ label: 'Guilds', href: '/guilds' });
  });
});
