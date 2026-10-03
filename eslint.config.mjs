import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// Every rule reports at warn level first so lint can gate CI without a big-bang cleanup;
// promote rules to errors as the warnings are burned down.
const warnOnly = (configs) =>
  configs.map((config) =>
    config.rules
      ? {
          ...config,
          rules: Object.fromEntries(
            Object.entries(config.rules).map(([name, setting]) => {
              const [level, ...options] = Array.isArray(setting) ? setting : [setting];
              return [name, ['error', 2, 'error'].includes(level) ? ['warn', ...options] : setting];
            }),
          ),
        }
      : config,
  );

export default defineConfig([
  ...warnOnly(nextVitals),
  ...warnOnly(nextTypescript),
  globalIgnores([
    '.next/**',
    '.next-*/**',
    'out/**',
    'build/**',
    'artifacts/**',
    'test-results/**',
    'playwright-report/**',
    'next-env.d.ts',
  ]),
]);
