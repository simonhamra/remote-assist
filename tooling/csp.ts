import type { Plugin } from 'vite';

const PLACEHOLDER = '__CSP__';

const production = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Vite's dev server injects inline <style> tags, the React Refresh preamble and an HMR websocket.
const development = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Fills the `__CSP__` placeholder in each renderer page: strict for builds, relaxed for `dev`. */
export function contentSecurityPolicy(): Plugin {
  let policy = production;
  return {
    name: 'remote-assist:csp',
    configResolved(config) {
      policy = config.command === 'serve' ? development : production;
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace(PLACEHOLDER, policy),
    },
  };
}
