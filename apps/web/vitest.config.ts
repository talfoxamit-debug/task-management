import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@taskos/engine': path.resolve(__dirname, '../../packages/engine/src/index.ts'),
      '@taskos/mcp': path.resolve(__dirname, '../mcp/src/index.ts'),
    },
  },
  test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 },
});
