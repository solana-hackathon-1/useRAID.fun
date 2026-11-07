// DEC-2026-11-07-01 (d) static guard: no console.error/warn/info/log/debug call in src passes an error, its
// message, stack or cause (or a variable derived from one) to the operator log. Failures go through
// operatorErrorFields()/operatorLogLine(), which emit a code plus a safe class only.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const src = join(root, 'src');
// Browser-only error boundary: runs in the visitor's own console, never in an operator log.
const NOT_OPERATOR_LOGS = new Set(['src/app/global-error.tsx']);
const SAFE_WRAPPERS = new Set([
  'operatorErrorFields',
  'operatorLogLine',
  'classifyIdentityStorageFailure', // yields a closed code set
]);
const ERRORISH = new Set(['error', 'err', 'e', 'bookkeeping', 'message', 'reason', 'cause']);
const METHODS = new Set(['error', 'warn', 'info', 'log', 'debug', 'trace']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}
export function offenders(source: string, fileName = 'x.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node, safe: boolean) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      SAFE_WRAPPERS.has(node.expression.text)
    )
      safe = true;
    if (
      !safe &&
      ts.isPropertyAccessExpression(node) &&
      ['message', 'stack', 'cause'].includes(node.name.text)
    )
      found.push(node.getText());
    else if (!safe && ts.isIdentifier(node) && ERRORISH.has(node.text)) {
      const parent = node.parent;
      const isKey = ts.isPropertyAssignment(parent) && parent.name === node;
      const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isKey && !isMember) found.push(node.text);
    }
    node.forEachChild((child) => visit(child, safe));
  };
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console' &&
      METHODS.has(node.expression.name.text)
    )
      for (const arg of node.arguments) visit(arg, false);
    node.forEachChild(walk);
  };
  walk(sf);
  return found;
}

describe('operator log guard', () => {
  it('detects an error, its message or a derived variable passed to console', () => {
    expect(offenders('try {} catch (error) { console.error(error); }')).toEqual(['error']);
    expect(offenders('console.error(JSON.stringify({ error: e.message }));')).toEqual([
      'e.message',
      'e',
    ]);
    expect(offenders('console.warn("x", String(error));')).toEqual(['error']);
    expect(offenders('console.error(JSON.stringify({ job: 1, error: message }));')).toEqual([
      'message',
    ]);
  });
  it('allows fixed text, ids and the safe wrappers', () => {
    expect(
      offenders('console.error(JSON.stringify({ job: job.id, ...operatorErrorFields(error) }));'),
    ).toEqual([]);
    expect(offenders('console.error(operatorLogLine("request-failed", error));')).toEqual([]);
    expect(offenders('console.warn("fixed text");')).toEqual([]);
  });
  it('no source file under src logs an error, message, stack or cause', () => {
    const bad: Record<string, string[]> = {};
    for (const file of files(src)) {
      const rel = relative(root, file);
      if (NOT_OPERATOR_LOGS.has(rel)) continue;
      const found = offenders(readFileSync(file, 'utf8'), file);
      if (found.length) bad[rel] = found;
    }
    expect(bad).toEqual({});
  });
});
