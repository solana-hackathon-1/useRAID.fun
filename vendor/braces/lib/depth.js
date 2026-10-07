'use strict';

// Local security backport for GHSA-vfj7-8cjw-p6xm. Never allow an option
// to raise this bound; every recursive walker must stay within it.
const MAX_DEPTH = 128;

const assertDepth = depth => {
  if (depth > MAX_DEPTH) {
    throw new SyntaxError(`Pattern nesting exceeds maximum depth (${MAX_DEPTH})`);
  }
};

// AST overloads must be bounded too. Iterate before invoking upstream's
// recursive walkers; ignore parent/prev links, which are normal backreferences.
const assertAstDepth = ast => {
  const stack = [{ node: ast, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (node && node.nodes) {
      assertDepth(depth);
      for (const child of node.nodes) stack.push({ node: child, depth: depth + 1 });
    }
  }
};

module.exports = { assertDepth, assertAstDepth };
