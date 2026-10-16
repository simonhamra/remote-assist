import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { contentSecurityPolicy } from '../../tooling/csp';

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), contentSecurityPolicy()],
  },
});
