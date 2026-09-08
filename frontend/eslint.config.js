/**
 * Frontend lint rules.
 *
 * `npm run lint` was silently checking nothing — there was no config here, so ESLint
 * reported every file as "ignored because no matching configuration was supplied" and
 * exited zero. A lint script that always passes is worse than no lint script.
 */
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // The new JSX transform: React is not in scope and does not need to be.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // An unused caught error is the documented way to say "this failure is expected
      // and handled by falling through" — it appears throughout the storage helpers.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
