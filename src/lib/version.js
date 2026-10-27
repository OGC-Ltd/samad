// The app's version, as shown in the sidebar foot and on the login page.
//
// Injected by vite.config.js `define` from package.json at build (and dev)
// time — bump it with `npm version patch|minor|major --no-git-tag-version`.
// The `typeof` guards keep this importable anywhere the define did not run.

/* global __APP_VERSION__, __APP_COMMIT__, __APP_BUILT__ */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const APP_COMMIT  = typeof __APP_COMMIT__  !== 'undefined' ? __APP_COMMIT__  : '';
export const APP_BUILT   = typeof __APP_BUILT__   !== 'undefined' ? __APP_BUILT__   : '';

/** "v1.0.0" */
export const versionLabel = () => `v${APP_VERSION}`;

/** "Version 1.0.0 · build 9a1c2f3 · 2 Oct 2026" — for a tooltip, where support reads it. */
export function buildDetail() {
  const parts = [`Version ${APP_VERSION}`];
  if (APP_COMMIT) parts.push(`build ${APP_COMMIT}`);
  const built = APP_BUILT ? new Date(APP_BUILT) : null;
  if (built && !Number.isNaN(built.getTime())) {
    parts.push(built.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  }
  return parts.join(' · ');
}

/** "© 2026" — the CURRENT year, read when rendered, never a build-time constant. */
export const copyrightLabel = (now = new Date()) => `© ${now.getFullYear()}`;
