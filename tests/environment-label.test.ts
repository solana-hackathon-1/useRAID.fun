import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ refresh() {}, push() {} }),
}));
import { deploymentEnvironment } from '../src/lib/deployment-environment';
import { Shell } from '../src/components/shell';
import { EnvironmentLabel } from '../src/components/environment-label';
import { fetchEnvironmentLabel } from '../src/lib/environment-label-client';
import { GET as environmentRoute } from '../src/app/api/environment/route';

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

describe('shared label component', () => {
  const label = (environment: { label: string; declared: boolean }) =>
    renderToStaticMarkup(createElement(EnvironmentLabel, { environment }));
  it('is the markup Shell renders, so the two surfaces cannot drift', () => {
    const environment = { label: 'Pilot', declared: true };
    expect(
      renderToStaticMarkup(
        createElement(Shell, { demo: false, account: null, environment, children: null }),
      ),
    ).toContain(label(environment));
  });
  it('cannot be dismissed: no button, link, close control or hidden state', () => {
    const out = label({ label: 'Staging', declared: true });
    expect(out).not.toMatch(/<button|<a[ >]|aria-hidden|hidden|dismiss|close/i);
    expect(out).toBe(
      '<div class="env-label"><span class="env-label-name">Staging</span><span class="env-label-detail">Not production</span></div>',
    );
  });
});

describe('GET /api/environment', () => {
  it('reports only the validated label for a non-production deployment, uncached', async () => {
    vi.stubEnv('RAID_ENVIRONMENT', 'staging');
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('STUDIO_SANDBOX', '');
    const response = await environmentRoute();
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
    expect(await response.json()).toEqual({ production: false, declared: true, label: 'Staging' });
    vi.unstubAllEnvs();
  });
  it('reports production as production, and fails safe when undeclared', async () => {
    vi.stubEnv('RAID_ENVIRONMENT', 'production');
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('STUDIO_SANDBOX', '');
    expect(await (await environmentRoute()).json()).toMatchObject({ production: true });
    vi.stubEnv('RAID_ENVIRONMENT', '');
    expect(await (await environmentRoute()).json()).toMatchObject({
      production: false,
      declared: false,
    });
    vi.unstubAllEnvs();
  });
});

describe('error page environment label (global-error replaces the layout, so it cannot get the Shell prop)', () => {
  const reply = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  it('returns the label for a non-production response', async () => {
    expect(
      await fetchEnvironmentLabel(reply({ production: false, declared: true, label: 'Pilot' })),
    ).toEqual({ label: 'Pilot', declared: true });
  });
  it('returns nothing for production, a failed request, or an unexpected body', async () => {
    expect(
      await fetchEnvironmentLabel(reply({ production: true, declared: true, label: 'Production' })),
    ).toBeNull();
    expect(await fetchEnvironmentLabel(reply({}, false))).toBeNull();
    expect(await fetchEnvironmentLabel(reply({ production: false, label: 7 }))).toBeNull();
    expect(
      await fetchEnvironmentLabel((async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch),
    ).toBeNull();
  });
  it('the error page renders the shared label component and no copy of the markup', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync(`${__dirname}/../src/app/global-error.tsx`, 'utf8');
    expect(page).toContain('EnvironmentLabel');
    expect(page).toContain('fetchEnvironmentLabel');
    expect(page).not.toContain('env-label');
  });
});

describe('staging compose', () => {
  it('declares the staging environment for web and worker through the shared safe environment', async () => {
    const { readFileSync } = await import('node:fs');
    const compose = readFileSync(`${__dirname}/../compose.staging.yaml`, 'utf8');
    expect(compose).toMatch(/safe-environment\n(?:\s+\S.*\n)*?\s+RAID_ENVIRONMENT: staging\n/);
  });
});
