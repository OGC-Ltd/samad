import { describe, it, expect } from 'vitest';
import { initialsOf, avatarHue } from './avatar';

describe('initialsOf', () => {
  it('takes first and last word, or the first two letters', () => {
    expect(initialsOf('Juma Ali Mwakilema')).toBe('JM');
    expect(initialsOf('juma')).toBe('JU');
  });
  it('falls back to the email local part', () => {
    expect(initialsOf('', 'jane.doe@example.com')).toBe('JD');
    expect(initialsOf('', '')).toBe('?');
  });
});

describe('avatarHue', () => {
  it('is stable per name', () => {
    expect(avatarHue('Jane Doe')).toBe(avatarHue('Jane Doe'));
    expect(avatarHue('Jane Doe')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
