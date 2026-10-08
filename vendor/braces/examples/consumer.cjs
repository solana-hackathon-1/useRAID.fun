'use strict';

const assert = require('node:assert/strict');
const braces = require('..');

assert.deepEqual(braces.expand('file.{ts,tsx}'), ['file.ts', 'file.tsx']);
assert.deepEqual(braces.expand('{1..3}'), ['1', '2', '3']);
assert.throws(() => braces.compile('{'.repeat(4000) + 'a,b' + '}'.repeat(4000)), SyntaxError);
assert.throws(() => braces.expand('('.repeat(4000) + 'a' + ')'.repeat(4000)), SyntaxError);
console.log('Independent braces consumer: normal expansion and bounded rejection passed.');
