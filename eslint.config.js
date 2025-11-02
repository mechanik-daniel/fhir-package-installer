import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

// Global ignore block ensures build outputs & caches are never linted.
export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'test/.test-cache/**'] },
  { files: ['**/*.{js,mjs,cjs,ts}'], plugins: { js }, extends: ['js/recommended'], languageOptions: { globals: globals.node } },
  { files: ['**/*.{js,mjs,cjs,ts}'], languageOptions: { globals: globals.browser },
    rules: {
      indent: ['error', 2],
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      'no-unused-vars': ['warn'],
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    } },
  tseslint.configs.recommended,
]);
