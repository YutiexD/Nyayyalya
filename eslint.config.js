/**
 * Flat ESLint config (ESLint 9).
 *
 * The rules that matter here are the security ones, not the style ones:
 * `no-eval`, `no-implied-eval` and `no-new-func` are errors, and `no-console` keeps
 * output going through the structured logger where redaction is applied.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'frontend/node_modules/**',
      // contracts/ is a separate CJS package with its own Hardhat/Mocha tooling.
      'contracts/**',
      'coverage/**',
      'frontend/dist/**',
      // The web client is a React package with its own flat config, its own plugins
      // (react, react-hooks) and its own parser options for JSX. Linting it from here
      // with the Node config reports JSX as a syntax error and React hooks as unused
      // variables — noise that hides real findings in the backend. Run `npm run lint`
      // inside frontend/ for that tree.
      'frontend/src/**',
      'frontend/*.config.js',
      'frontend-legacy/**',
      '.data/**',
      'vault/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        // Web-standard globals that Node 18+ provides natively.
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        AbortController: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      // --- correctness ---
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      eqeqeq: ['error', 'smart'],

      // --- security ---
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-proto': 'error',
      'no-extend-native': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],

      // --- async correctness: a dropped await here loses an audit row ---
      'require-atomic-updates': 'warn',
      'no-return-await': 'warn',
    },
  },
  {
    /**
     * `require-atomic-updates` reports every `req.foo = ...` in an async Express
     * handler as a possible race. It is a false positive here: a request object is
     * owned by exactly one request, and Express never runs two handlers against the
     * same `req` concurrently. Twenty-one known-false warnings would hide the first
     * true one, so the rule is off for the request-handling layer and stays on
     * everywhere else.
     */
    files: ['backend/middleware/**/*.js', 'backend/controllers/**/*.js', 'backend/tests/helpers/**/*.js'],
    rules: { 'require-atomic-updates': 'off' },
  },
  {
    // Scripts, seeds and the directory services print to the console by design.
    files: ['scripts/**/*.js', 'seed/**/*.js', 'directories/**/*.js', 'contracts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['backend/tests/**/*.js'],
    languageOptions: {
      globals: { describe: 'readonly', it: 'readonly', expect: 'readonly', vi: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
  {
    // Browser code.
    files: ['frontend/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        indexedDB: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        alert: 'readonly',
        console: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        CustomEvent: 'readonly',
        HTMLElement: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
];
