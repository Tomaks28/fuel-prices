import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'dist-cli/', 'coverage/', 'node_modules/'] },

  js.configs.recommended,

  // Type-aware linting: the rules below need the TS program, so keep sources in tsconfig.
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling configs live outside tsconfig's `include`.
          allowDefaultProject: ['*.config.js', '*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    rules: {
      // A published SDK should never silently widen types.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },

  // Config files are tooling, not shipped code.
  {
    files: ['*.config.{js,ts}'],
    rules: { 'no-console': 'off' },
  },

  // Must stay last so formatting-related rules are switched off.
  prettier,
);
