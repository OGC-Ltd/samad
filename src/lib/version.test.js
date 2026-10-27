import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_VERSION, versionLabel, copyrightLabel, buildDetail } from './version';

describe('version', () => {
  it("is package.json's version, injected by vite.config.js", () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(APP_VERSION).toBe(pkg.version);
    expect(versionLabel()).toBe(`v${pkg.version}`);
    expect(buildDetail()).toMatch(new RegExp(`^Version ${pkg.version.replace(/\./g, '\\.')}`));
  });

  it('reads the copyright year when rendered, not when built', () => {
    expect(copyrightLabel(new Date(2027, 0, 1))).toBe('© 2027');
    expect(copyrightLabel()).toBe(`© ${new Date().getFullYear()}`);
  });
});
