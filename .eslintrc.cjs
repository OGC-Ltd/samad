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
    // react-hooks 7 adds the React Compiler's rules. The app is not compiled
    // with it, and these two flag patterns it relies on: the "latest value"
    // ref written during render, and state reset when a prop changes.
    'react-hooks/refs': 'off',
    'react-hooks/set-state-in-effect': 'off',
  },
  overrides: [
    // Build tooling runs in Node, not the browser.
    { files: ['vite.config.js', 'scripts/**/*.{js,mjs}', '*.cjs'], env: { node: true, browser: false } },
  ],
}
