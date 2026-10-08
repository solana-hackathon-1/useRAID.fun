import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (file: string) => readFileSync(file, 'utf8');
describe('deploy configuration', () => {
  it('migrates before both services deploy', () => {
    expect(read('railway.toml')).toMatch(/preDeployCommand = "npm run db:migrate"/);
    expect(read('railway.worker.toml')).toMatch(/preDeployCommand = "npm run db:migrate"/);
  });
  it('checks the schema before the worker loop starts', () => {
    const worker = read('src/worker.ts');
    expect(worker.indexOf('await assertSchemaCurrent()')).toBeGreaterThan(0);
    expect(worker.indexOf('await assertSchemaCurrent()')).toBeLessThan(
      worker.indexOf('while (!stopping)'),
    );
  });
  it('ships a multi-stage image with the migration CLI and no tests', () => {
    const docker = read('Dockerfile');
    expect(docker.match(/^FROM /gm)).toHaveLength(3);
    expect(docker).toMatch(/npm prune --omit=dev/);
    expect(docker).toMatch(/COPY --from=build \/app\/prisma /);
    expect(docker).not.toMatch(/COPY --from=build \/app\/tests/);
    expect(read('.dockerignore')).toMatch(/^tests$/m);
  });
  it('excludes the test-only fixture example whose dependencies are outside the image context', () => {
    expect(read('.dockerignore')).toMatch(/^examples\/raid-fixtures$/m);
    expect(read('tests/raid-fixtures-boundary.test.ts')).toContain(
      'examples/raid-fixtures/host.ts',
    );
  });
  it('keeps runtime tools in dependencies and pins the framework', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies.prisma).toBeDefined();
    expect(pkg.devDependencies.prisma).toBeUndefined();
    expect(pkg.dependencies.tsx).toBeDefined();
    for (const name of ['next', 'react', 'react-dom']) {
      expect(pkg.dependencies[name]).toMatch(/^~\d+\.\d+\.\d+$/);
    }
  });
  it('smoke-tests the image in CI', () => {
    expect(read('.github/workflows/checks.yml')).toMatch(/docker build -t useraid:ci/);
  });
});
