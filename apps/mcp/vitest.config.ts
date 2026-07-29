import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@taskos/engine': path.resolve(__dirname, '../../packages/engine/src/index.ts'),
    },
  },
  test: {
    // The integration tests share one database and mutate it in sequence.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
