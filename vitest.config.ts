import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'server/src/**/*.test.ts',
      'tooling/**/*.test.ts',
    ],
    environment: 'node',
  },
});
