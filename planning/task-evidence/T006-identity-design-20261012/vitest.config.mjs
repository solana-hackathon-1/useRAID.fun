import { fileURLToPath } from 'node:url';
export default {
  test: {
    include: [fileURLToPath(new URL('./probes/*.test.ts', import.meta.url))],
    fileParallelism: false,
    hookTimeout: 60000,
  },
  resolve: { alias: { '@': fileURLToPath(new URL('../../../src', import.meta.url)) } },
};
