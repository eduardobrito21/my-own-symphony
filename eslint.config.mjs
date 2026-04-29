// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Globally ignore build output, deps, and root-level config files.
    // Config files live outside any tsconfig project, so the type-aware
    // rules below cannot be applied to them.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'coverage/**',
      // Top-level config files live outside any tsconfig — the
      // type-aware rules below can't apply to them, so skip entirely.
      '*.cjs',
      '*.mjs',
      '*.js',
      'vitest.config.ts',
      '.dependency-cruiser.cjs',
      // Helper scripts under `scripts/` get a dedicated, looser
      // override block below — NOT a global ignore. They're real
      // code that should be linted; just not under the strict
      // type-aware rules that target the typed core.
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Force exhaustive checks on discriminated unions: matches the article's
      // "make invariants mechanical" principle. Catches the missing case at
      // compile time rather than runtime.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Errors must be thrown or explicitly returned, not swallowed.
      '@typescript-eslint/no-floating-promises': 'error',

      // Use type-only imports where possible — pairs with verbatimModuleSyntax.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Allow `_`-prefixed unused args (common in interface implementations).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Numbers and booleans are fine in template literals. Restricting to
      // strings only would force awkward `${String(n)}` casts in every
      // error message and log line — not a tradeoff that earns its keep.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // Tests can be looser.
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Helper scripts under `scripts/` are standalone Node `.mjs`
    // files (e.g. list-linear-projects.mjs). They aren't part of the
    // typed core and run as-is via `node --env-file=.env <path>`.
    //
    // We disable type-aware rules here (the parser can't infer types
    // for plain JS without JSDoc) and declare the Node globals they
    // rely on (`console`, `process`, `fetch`, etc.) so basic safety
    // rules still run.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
);
