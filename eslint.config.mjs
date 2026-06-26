// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config (ESLint 9+) mirroring the conventions used by the Microsoft VS Code
 * extensions: the TypeScript-ESLint recommended set plus a few type-aware rules that catch the
 * mistakes the compiler can't (floating/misused promises). Generated artefacts and the CommonJS
 * test/build scripts are linted with the base JS rules only.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', '**/*.cjs', '**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-throw-literal': 'error',
    },
  },
);
