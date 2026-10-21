import { globSync } from 'node:fs';
import path from 'node:path';
import { identityArchitecture } from './identity-architecture';
const root = process.cwd();
const errors = identityArchitecture(
  root,
  globSync('src/**/*.ts').map((file) => path.join(root, file)),
);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('PASS: identity AST fence; reviewed exceptions and User FK inventory');
