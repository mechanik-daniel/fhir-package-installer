import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

// Global ignore block ensures build outputs & caches are never linted.
export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'test/.test-cache/**', '**/*.ts', '**/*.tsx'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      indent: ['error', 2],
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      'no-unused-vars': ['warn'],
      'no-console': ['error']
    }
  },
  {
    files: ['test/**/*.{js,mjs,cjs}'],
    rules: {
      'no-console': 'off'
    }
  }
]);
