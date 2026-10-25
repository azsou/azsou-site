import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';

const browserAndNode = Object.fromEntries(
  [
    'window',
    'document',
    'console',
    'process',
    'URL',
    'fetch',
    'localStorage',
    'navigator',
    'location',
    'setTimeout',
    'clearTimeout',
    'AbortController',
    'self',
    'caches',
    'Response',
    'HTMLElement',
    'HTMLInputElement',
    'URLSearchParams',
    'Buffer',
    '__dirname',
    'history',
    'getComputedStyle',
    'addEventListener',
  ].map((g) => [g, 'readonly']),
);

export default [
  {
    ignores: [
      'legacy/**',
      'dist/**',
      'dist-ads/**',
      '.vercel/**',
      '.astro/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      '.lighthouseci/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    languageOptions: { globals: { ...browserAndNode, module: 'writable' } },
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
];
