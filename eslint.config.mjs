import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'contract/src/managed/**',
      'contract/build/**',
      // generated compactc output anywhere (probe workspaces compile throwaway contracts)
      '**/managed/**',
      'probes/*/discovery/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Node globals for plain JS/MJS tooling scripts. TypeScript files do not need this:
    // typescript-eslint's recommended config turns `no-undef` off for them, since the type
    // checker already catches undefined names. Without this block, every `console` and
    // `process` in a .mjs script is a `no-undef` error.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        // Global since Node 18; used by probe tooling that queries the indexer over HTTP.
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // ui/ is browser code. `@yahtzee/api/node` carries wallet-sdk and other Node-only plumbing
    // that must never reach a browser bundle (ui/README.md), and no `node:` builtin belongs
    // there either — this is the cheap lint-time half of that rule; `npm run build -w ui`
    // failing to bundle a Node builtin is the expensive half.
    files: ['ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The live-table views poll on intervals keyed off props; exhaustive-deps is the rule
      // that catches a stale closure silently freezing a table's state.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@yahtzee/api/node', '@yahtzee/api/node/*'],
              message:
                'Node-only plumbing (wallet-sdk, proof/zk-config providers) — never import from ui.',
            },
            {
              group: ['node:*'],
              message: 'Node builtins are not available in the browser.',
            },
          ],
        },
      ],
    },
  },
);
