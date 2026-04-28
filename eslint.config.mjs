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
      '*.cjs',
      '*.mjs',
      '*.js',
      'vitest.config.ts',
      '.dependency-cruiser.cjs',
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
    },
  },
  {
    // Tests can be looser.
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
