import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Methodology from '../src/app/methodology/page';

const html = renderToStaticMarkup(createElement(Methodology));
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
describe('How it works page', () => {
  it('explains the flow and what the app is limited to', () => {
    expect(text).toMatch(/How it works/i);
    for (const topic of ['Connect X', 'Solana wallet', 'USDC', 'What useRAID does not do'])
      expect(text).toContain(topic);
    expect(text).toMatch(/not (a )?(trading|investment)/i);
    expect(text).toMatch(/impressions are not unique people/i);
  });
  it('drops the legacy v1 scoring detail, approval wording and progress dashboard', () => {
    for (const junk of [
      'Attention score v1',
      'Legacy v1',
      'Creator approval grants pilot access',
      'issues completed',
    ])
      expect(text).not.toContain(junk);
  });
  it('stays short enough to read', () => {
    expect(text.split(' ').length).toBeLessThan(450);
  });
});
