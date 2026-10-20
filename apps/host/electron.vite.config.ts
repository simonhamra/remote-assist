import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { contentSecurityPolicy } from '../../tooling/csp';
import { bakedSignalingUrl } from '../../tooling/release';

// Everything is bundled, workspace packages included, so the packaged app ships no
// node_modules. (Sandboxed preload scripts cannot load modules at all.)
const externalizeDeps = false;

export default defineConfig({
  main: {
    define: { __SIGNALING_URL__: JSON.stringify(bakedSignalingUrl(process.env)) },
    build: { externalizeDeps },
  },
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
