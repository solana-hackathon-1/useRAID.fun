import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ refresh() {}, push() {} }),
}));
import { deploymentEnvironment } from '../src/lib/deployment-environment';
import { Shell } from '../src/components/shell';

describe('deploymentEnvironment', () => {
  it('is production only when RAID_ENVIRONMENT is exactly production', () => {
    expect(deploymentEnvironment({ RAID_ENVIRONMENT: 'production' }).production).toBe(true);
    expect(deploymentEnvironment({ RAID_ENVIRONMENT: ' Production ' }).production).toBe(true);
  });
  it.each([
    ['staging', 'Staging'],
    ['pilot', 'Pilot'],
    ['alpha', 'Alpha'],
    ['demo', 'Demo'],
    ['local', 'Local development'],
  ])('labels %s as not production', (value, label) => {
    expect(deploymentEnvironment({ RAID_ENVIRONMENT: value })).toMatchObject({
      production: false,
      declared: true,
      label,
    });
  });
  it.each([[undefined], [''], ['prod'], ['live'], ['staging2']])(
    'fails safe to a visible undeclared label for %j, never silently production',
    (value) => {
      expect(deploymentEnvironment({ RAID_ENVIRONMENT: value })).toMatchObject({
        production: false,
        declared: false,
        label: 'Environment not declared',
      });
    },
  );
  it('keeps the label when production is declared but demo or sandbox mode is on', () => {
    const base = { RAID_ENVIRONMENT: 'production' };
    expect(deploymentEnvironment({ ...base, DEMO_MODE: 'true' })).toMatchObject({
      production: false,
      label: 'Demo',
    });
    expect(deploymentEnvironment({ ...base, STUDIO_SANDBOX: 'true' })).toMatchObject({
      production: false,
      label: 'Local development',
    });
  });
});

describe('persistent non-production label', () => {
  const html = (environment?: { label: string; declared: boolean } | null) =>
    renderToStaticMarkup(
      createElement(Shell, { demo: false, account: null, environment, children: null }),
    );
  it('renders inside the sticky header before the navigation, and is not a live region', () => {
    const out = html({ label: 'Staging', declared: true });
    expect(out).toContain('class="env-label"');
    // Present on every page: a live region would be announced needlessly and collide with real page statuses.
    expect(out).not.toContain('role="status"');
    expect(out).toContain('Staging');
    expect(out).toContain('Not production');
    expect(out.indexOf('env-label')).toBeGreaterThan(out.indexOf('site-header'));
    expect(out.indexOf('env-label')).toBeLessThan(out.indexOf('header-inner'));
  });
  it('tells the viewer to treat an undeclared environment as not production', () => {
    const out = html({ label: 'Environment not declared', declared: false });
    expect(out).toContain('Environment not declared');
    expect(out).toMatch(/treat as not production/i);
  });
  it('renders nothing for production', () => {
    expect(html(null)).not.toContain('env-label');
  });
});

describe('staging compose', () => {
  it('declares the staging environment for web and worker through the shared safe environment', async () => {
    const { readFileSync } = await import('node:fs');
    const compose = readFileSync(`${__dirname}/../compose.staging.yaml`, 'utf8');
    expect(compose).toMatch(/safe-environment\n(?:\s+\S.*\n)*?\s+RAID_ENVIRONMENT: staging\n/);
  });
});
