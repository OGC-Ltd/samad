import { describe, it, expect } from 'vitest';
import { APP_VERSION, versionLabel, copyrightLabel, buildDetail } from './version';

describe('version', () => {
  it('is the deploy number vite.config.js injected (1.0, 1.1, …, or dev)', () => {
    expect(APP_VERSION).toMatch(/^(\d+\.\d(-dev)?|dev)$/);
    expect(versionLabel()).toBe(`v${APP_VERSION}`);
    expect(buildDetail().startsWith(`Version ${APP_VERSION}`)).toBe(true);
  });

  it('reads the copyright year when rendered, not when built', () => {
    expect(copyrightLabel(new Date(2027, 0, 1))).toBe('© 2027');
    expect(copyrightLabel()).toBe(`© ${new Date().getFullYear()}`);
  });
});
