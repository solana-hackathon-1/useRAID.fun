import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TestCenter } from './components/test-center';

const html = renderToStaticMarkup(createElement(TestCenter, { sandbox: false }));
assert(html.includes('Implementation test center'));
assert(html.includes('Read-only product preview'));
assert(html.includes('Exact amount explorer'));
assert(html.includes('Capacity state explorer'));
assert(html.includes('Review and integration pending'));
assert(!html.includes('Enter test Creator Studio'));
console.log(
  'Independent host rendered the read-only test center without Next.js, DB or credentials.',
);
