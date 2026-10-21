import ts from 'typescript';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const astHash = (node: ts.Node, source: ts.SourceFile) =>
  createHash('sha256')
    .update(
      ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, node, source),
    )
    .digest('hex');
const mutations = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);
export function identityArchitecture(
  root: string,
  files: string[],
  manifestPatch: { trustedAdvisoryFunctions?: Record<string, string> } = {},
) {
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'planning/identity-writer-fence.json'), 'utf8'),
  ) as {
    protectedModels: string[];
    schemaRelations: string[];
    userKeys: string[];
    trustedFunctions: Record<string, string>;
    trustedRawFunctions: Record<string, string>;
    multiUserFunctions: Record<string, string>;
    trustedAdvisoryFunctions?: Record<string, string>;
  };
  manifest.trustedAdvisoryFunctions = {
    ...manifest.trustedAdvisoryFunctions,
    ...manifestPatch.trustedAdvisoryFunctions,
  };
  const schema = readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
  const relations = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .flatMap(([, model, body]) =>
      body
        .split('\n')
        .filter((line) => /\bUser\??\s+@relation/.test(line))
        .map((line) => `${model}:${line.trim()}`),
    )
    .sort();
  const errors: string[] = [];
  const userKeys = schema
    .match(/^model User \{([\s\S]*?)^\}/m)![1]
    .split('\n')
    .filter((line) => /@id|@unique/.test(line))
    .map((line) => line.trim())
    .sort();
  if (JSON.stringify(userKeys) !== JSON.stringify(manifest.userKeys))
    errors.push(
      'User unique-key classifier changed: review final root strengths before updating the fence',
    );
  if (JSON.stringify(relations) !== JSON.stringify(manifest.schemaRelations))
    errors.push('User FK inventory changed: classify new writers/locks before updating the fence');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(files, parsed.options),
    checker = program.getTypeChecker();
  function report(source: ts.SourceFile, node: ts.Node, reason: string) {
    errors.push(
      `${path.relative(root, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${reason}`,
    );
  }
  function enclosing(node: ts.Node): ts.FunctionDeclaration | undefined {
    for (let n: ts.Node | undefined = node; n; n = n.parent)
      if (ts.isFunctionDeclaration(n)) return n;
  }
  function trusted(source: ts.SourceFile, node: ts.Node, registry: Record<string, string>) {
    const fn = enclosing(node);
    return (
      !!fn?.name &&
      registry[`${path.relative(root, source.fileName)}#${fn.name.text}`] === astHash(fn, source)
    );
  }
  function scoped(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isCallExpression(node)) {
      let symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      return !!symbol?.declarations?.some(
        (d) =>
          ts.isFunctionDeclaration(d) &&
          d.name?.text === 'identityWriter' &&
          path.resolve(d.getSourceFile().fileName) ===
            path.join(root, 'src/lib/identity-protocol.ts'),
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return scoped(node.expression, seen);
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
      return scoped(declaration.initializer, seen);
    if (declaration && ts.isBindingElement(declaration)) {
      const parent = declaration.parent.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer)
        return scoped(parent.initializer, seen);
    }
    return false;
  }
  for (const source of program.getSourceFiles()) {
    if (!files.includes(source.fileName)) continue;
    const visit = (node: ts.Node) => {
      if (
        ts.isAsExpression(node) &&
        /TransactionClient|Delegate/.test(
          checker.typeToString(checker.getTypeAtLocation(node.expression)),
        ) &&
        /^(unknown|any)$/.test(node.type.getText(source))
      )
        report(source, node, 'identity transaction/delegate type erasure bypasses the fence');
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        // Public SQL ports also need a reviewed guard; constants cannot hide raw identity DML.
        const constant = (arg: ts.Node | undefined): string => {
          if (!arg) return '';
          if (ts.isIdentifier(arg)) {
            const declaration = checker.getSymbolAtLocation(arg)?.valueDeclaration;
            if (declaration && ts.isVariableDeclaration(declaration))
              return declaration.initializer?.getText(source) || '';
          }
          return arg.getText(source);
        };
        if (
          node.arguments.some((arg) =>
            /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:User|Session|OAuthAttempt|XAccount|WalletIdentity|Participant|WalletLink)\b/i.test(
              constant(arg),
            ),
          ) &&
          !trusted(source, node, manifest.trustedRawFunctions)
        )
          report(source, node, 'unclassified identity SQL through a public port');
        const receiver =
          ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
            ? expression.expression
            : expression;
        const type = checker.typeToString(checker.getTypeAtLocation(receiver));
        const methodType = checker.typeToString(checker.getTypeAtLocation(expression));
        const method = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isElementAccessExpression(expression) &&
              expression.argumentExpression &&
              ts.isStringLiteral(expression.argumentExpression)
            ? expression.argumentExpression.text
            : undefined;
        const mutation =
          (method && mutations.has(method)) ||
          (!method &&
            manifest.protectedModels.some((m) =>
              new RegExp(`${m}(?:Create|Update|Delete|Upsert)`).test(methodType),
            ));
        const identity = manifest.protectedModels.some(
          (m) =>
            type.includes(`${m}Delegate`) ||
            new RegExp(`${m}(?:Create|Update|Delete|Upsert)(?:Many|ManyAndReturn)?Args`).test(
              methodType,
            ),
        );
        if (
          mutation &&
          identity &&
          !scoped(receiver) &&
          !trusted(source, node, manifest.trustedFunctions)
        )
          report(source, node, 'identity mutation bypasses scoped protocol writer');
        if (method && mutations.has(method)) {
          const nested = (n: ts.Node) => {
            if (
              ts.isPropertyAssignment(n) &&
              /^(create|createMany|update|updateMany|upsert|delete|deleteMany|connect|disconnect|connectOrCreate)$/.test(
                n.name.getText(source),
              ) &&
              n.parent !== node.arguments[0]
            )
              report(source, n, 'nested relation mutation requires an explicit identity/FK plan');
            ts.forEachChild(n, nested);
          };
          for (const arg of node.arguments) if (ts.isObjectLiteralExpression(arg)) nested(arg);
          if (
            (method === 'createMany' || method === 'createManyAndReturn') &&
            relations.some((r) => type.includes(`${r.split(':')[0]}Delegate`)) &&
            !trusted(source, node, manifest.multiUserFunctions)
          )
            report(source, node, 'multi-User FK writer lacks reviewed full sorted root set');
        }
        if (method && /^\$(?:query|execute)Raw/.test(method)) {
          const text = node.arguments[0]?.getText(source) || '';
          const dynamic =
            ts.isIdentifier(node.arguments[0]) ||
            (text.includes('${') && /\b(?:INSERT|UPDATE|DELETE)\b/i.test(text));
          if (
            (dynamic ||
              /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["']?(?:User|Session|OAuthAttempt|XAccount|WalletIdentity|Participant|WalletLink)\b/i.test(
                text,
              )) &&
            !trusted(source, node, manifest.trustedRawFunctions)
          )
            report(source, node, 'unclassified raw identity SQL/transaction escape');
        }
      }
      if (
        (ts.isTaggedTemplateExpression(node) || ts.isCallExpression(node)) &&
        /pg_(?:try_)?advisory_xact_lock/.test(node.getText(source)) &&
        !source.fileName.endsWith('/src/identity-locks/index.ts') &&
        // Reviewed non-identity domain locks: hash-pinned function and the reserved seed range only,
        // so they can never alias the identity key space (seed 0 labels and fixed 729102-729104).
        !(
          trusted(source, node, manifest.trustedAdvisoryFunctions!) &&
          /pg_advisory_xact_lock\(\s*hashtextextended\(\s*\$1\s*,\s*120(?:1[2-9]|[2-9]\d)\s*\)\s*\)/.test(
            node.getText(source),
          )
        )
      )
        report(source, node, 'advisory acquisition bypasses the shared key/class builder');
      if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isPropertyAccessExpression(node.tag) &&
        /^\$(?:query|execute)Raw/.test(node.tag.name.text) &&
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:User|Session|OAuthAttempt|XAccount|WalletIdentity|Participant|WalletLink)\b/i.test(
          node.template.getText(source),
        ) &&
        !trusted(source, node, manifest.trustedRawFunctions)
      )
        report(source, node, 'raw identity mutation bypasses protocol');
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return errors;
}
