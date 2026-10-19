import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { contentSecurityPolicy } from '../../tooling/csp';

// Workspace packages are TypeScript sources: bundle them instead of loading them at runtime.
// (Sandboxed preload scripts cannot load modules at all.)
const externalizeDeps = {
  exclude: [
    '@remote-assist/crypto',
    '@remote-assist/desktop',
    '@remote-assist/native-input',
    '@remote-assist/protocol',
  ],
};

export default defineConfig({
  main: { build: { externalizeDeps } },
  preload: {
    build: {
      externalizeDeps,
      // Sandboxed preload scripts can't load other files, so each one must be self-contained.
      isolatedEntries: true,
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          bar: resolve(__dirname, 'src/preload/bar.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [react(), contentSecurityPolicy()],
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          bar: resolve(__dirname, 'src/renderer/bar.html'),
          border: resolve(__dirname, 'src/renderer/border.html'),
        },
      },
    },
  },
});
