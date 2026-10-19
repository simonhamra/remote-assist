import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { contentSecurityPolicy } from '../../tooling/csp';

// Workspace packages are TypeScript sources: bundle them instead of loading them at runtime.
// (Sandboxed preload scripts cannot load modules at all.)
const bundleWorkspace = {
  externalizeDeps: {
    exclude: ['@remote-assist/desktop', '@remote-assist/native-input', '@remote-assist/protocol'],
  },
};

export default defineConfig({
  main: { build: bundleWorkspace },
  preload: { build: bundleWorkspace },
  renderer: {
    plugins: [react(), contentSecurityPolicy()],
  },
});
