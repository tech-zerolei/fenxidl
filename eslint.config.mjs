/**
 * ESLint flat config (ESLint 9).
 *
 * Policy: this config must be *runnable and green* on the existing tree, so the
 * rules that only encode style preferences are downgraded or disabled, and the
 * rules that catch real bugs stay errors. Anything that would require touching
 * `src/main/**` or `src/renderer/**` to go green is deliberately a warning —
 * see `reports/infra.md` for the list of pre-existing warnings to burn down.
 *
 * Baseline at the time of writing (npm run lint): 0 errors, and the warning
 * count is recorded in reports/infra.md.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // Build output, dependencies, and generated packaging artefacts.
    ignores: ['node_modules/**', 'dist/**', 'release/**', 'assets/**', 'extension/**', 'eslint.config.mjs'],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    linterOptions: {
      // `eslint --report-unused-disable-directives` is off by default in v9;
      // surface dead disable comments as warnings instead of silently keeping them.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // --- Correctness: keep these loud --------------------------------
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-else-if': 'error',
      'no-unreachable-loop': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
      'require-atomic-updates': 'warn',
      // A `catch` that swallows everything without naming the error is the
      // pattern behind most of the silent failures in this project.
      'no-empty': ['warn', { allowEmptyCatch: false }],

      // --- Pre-existing debt: warn, do not fail the build --------------
      // 27 unbound `catch` blocks + 6 `.catch(() => undefined)` exist today.
      'no-unused-vars': 'off', // superseded by the TS-aware rule below
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-control-regex': 'warn',
      // `console` is the diagnostic channel of an Electron main process.
      'no-console': 'off',
      // Pure style: formatting is Prettier's job.
      'no-irregular-whitespace': ['warn', { skipStrings: true, skipComments: true }],
    },
  },

  // --- Renderer: React hooks correctness ------------------------------
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // A hook called conditionally is a real crash, so it stays an error.
      'react-hooks/rules-of-hooks': 'error',
      // Missing deps are frequently intentional (stable refs); warn only.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // --- Tests / scripts: looser --------------------------------------
  {
    files: ['src/test/**/*.ts', 'build/**/*.mjs'],
    rules: {
      // Test bodies throw inside try/finally and use console for the report.
      'no-empty': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // --- Build scripts are ESM Node programs ---------------------------
  {
    files: ['build/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },

  // --- Legacy CommonJS helper scripts (.cjs) -------------------------
  // These are plain `require`-style Node scripts that run outside the bundle,
  // so the ESM import rules do not apply to them.
  {
    files: ['build/**/*.cjs', '*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
