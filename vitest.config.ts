import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false, hookTimeout: 60000 },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});
