module.exports = {
  root: true,
  // Control Tech's VSS player SDK, vendored as served (public/vss-sdk/README.md).
  // and the build output.
  ignorePatterns: ['public/vss-sdk/', 'build/', 'dist/'],
  env: { browser: true, es2021: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
  },
  overrides: [
    // Build tooling runs in Node, not the browser.
    { files: ['vite.config.js', 'scripts/**/*.{js,mjs}', '*.cjs'], env: { node: true, browser: false } },
  ],
}
