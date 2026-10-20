import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/node_modules/', '**/out/', '**/dist/', 'test-results/', 'playwright-report/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['apps/*/src/renderer/**/*.{ts,tsx}', 'packages/**/*.ts'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      '*.{js,ts}',
      'e2e/**/*.ts',
      'tooling/**/*.ts',
      'apps/*/*.ts',
      'apps/*/src/{main,preload}/**/*.ts',
      'packages/*/scripts/**/*.mjs',
      'tooling/**/*.mjs',
      'apps/*/*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  prettier,
]);
