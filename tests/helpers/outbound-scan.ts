import ts from 'typescript';

/**
 * Finds outbound HTTP calls in TypeScript source (T091 / blueprint §28.3), by syntax tree so comments, strings and
 * spelling can't fool it.
 * - `provider`: the first-argument text of every `providerFetch(` call, which must be a literal pinned https URL.
 * - `raw`: any value use of the global `fetch` (a call, an alias, `.call`, a cast or element access on `globalThis`,
 *   destructuring) and any import of another HTTP client. Server code may have none: raw fetch follows redirects, so
 *   only providerFetch (redirects refused) may reach a provider.
 * Type positions, `client.fetch`, object keys and a `function fetch` declaration are not uses.
 */
const HTTP_CLIENTS = /^(?:node:)?(?:https?|http2)$|^(?:undici|axios|got|node-fetch|ky)$/;
const GLOBALS = new Set(['globalThis', 'global', 'self', 'window']);

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    ? unwrap(node.expression)
    : node;
const isGlobalObject = (node: ts.Expression) => {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) && GLOBALS.has(inner.text);
};
const inTypePosition = (node: ts.Node): boolean => {
  for (let at: ts.Node = node; at.parent; at = at.parent) {
    if (ts.isTypeNode(at)) return true;
    if (ts.isStatement(at)) return false;
  }
  return false;
};
/** A declared name or key, not a read of the global. */
const isNameOnly = (node: ts.Identifier) => {
  const parent = node.parent;
  return (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) &&
      parent.name === node &&
      !isGlobalObject(parent.expression))
  );
};

export function scanOutboundCalls(text: string) {
  const file = ts.createSourceFile(
    'scan.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const provider: string[] = [];
  const raw: string[] = [];
  const line = (node: ts.Node) => node.getText(file).slice(0, 120);
  const clientModule = (node: ts.Expression | undefined) =>
    !!node && ts.isStringLiteralLike(node) && HTTP_CLIENTS.test(node.text);
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === 'fetch' && !inTypePosition(node)) {
      if (!isNameOnly(node)) raw.push(line(node.parent));
    } else if (
      ts.isElementAccessExpression(node) &&
      isGlobalObject(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'fetch'
    ) {
      raw.push(line(node));
    } else if (ts.isImportDeclaration(node) && clientModule(node.moduleSpecifier)) {
      raw.push(line(node));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'providerFetch')
        provider.push(node.arguments[0]?.getText(file).slice(0, 120) ?? '');
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      if (loads && clientModule(node.arguments[0])) raw.push(line(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { provider, raw };
}
