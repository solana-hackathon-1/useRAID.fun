import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/raids' }));
import { Shell } from '../src/components/shell';

const render = (extraLinks?: { href: string; label: string }[]) =>
  renderToStaticMarkup(
    createElement(Shell, { demo: false, account: null, extraLinks, children: null }),
  );
describe('main navigation', () => {
  it('keeps the existing entries and adds nothing by default', () => {
    const html = render();
    expect(html).toContain('Creator studio');
    expect(html).not.toContain('Live Raids');
  });
  it('shows an injected public entry in both the desktop and mobile navigation, marked current on its page', () => {
    const html = render([{ href: '/raids', label: 'Live Raids' }]);
    expect(html.match(/Live Raids/g)).toHaveLength(2);
    expect(html).toContain('aria-current="page"');
    expect(html.indexOf('Live Raids')).toBeLessThan(html.indexOf('Creator studio'));
  });
});
