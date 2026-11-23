import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIFE_MS, MAX_BEHIND, addToast, dismissToast, pauseToasts, resetToasts, toastsSnapshot } from './toasts';

const t = (id) => ({ id, kind: 'push', level: 'info', title: id, body: '' });
const front = () => toastsSnapshot().front?.id ?? null;

describe('toast queue', () => {
  beforeEach(() => { vi.useFakeTimers(); resetToasts(); });
  afterEach(() => { resetToasts(); vi.useRealTimers(); });

  it('puts the newest in front and keeps the rest behind it', () => {
    for (const id of ['a', 'b', 'c']) addToast(t(id));
    expect(front()).toBe('c');
    expect(toastsSnapshot().behind).toBe(2);
    dismissToast('c');
    expect(front()).toBe('b');
    dismissToast('b');
    expect(front()).toBe('a');
    dismissToast('a');
    expect(front()).toBe(null);
  });

  it('runs only the front clock, and gives a toast that comes forward its full 8 seconds', () => {
    addToast(t('a'));
    vi.advanceTimersByTime(6_000);
    addToast(t('b'));                       // a waits behind, its clock stopped
    vi.advanceTimersByTime(LIFE_MS - 1);
    expect(front()).toBe('b');
    vi.advanceTimersByTime(1);
    expect(front()).toBe('a');              // b ran out; a comes forward
    vi.advanceTimersByTime(LIFE_MS - 1);
    expect(front()).toBe('a');
    vi.advanceTimersByTime(1);
    expect(front()).toBe(null);
  });

  it('drops the oldest behind once too many wait', () => {
    for (let i = 0; i <= MAX_BEHIND + 2; i += 1) addToast(t(`n${i}`));
    expect(toastsSnapshot().behind).toBe(MAX_BEHIND);
    expect(front()).toBe(`n${MAX_BEHIND + 2}`);
  });

  it('shows a toast once, however often it arrives', () => {
    expect(addToast(t('a'))).toBe(true);
    expect(addToast(t('a'))).toBe(false);
    expect(toastsSnapshot().behind).toBe(0);
  });

  it('stands still while paused', () => {
    addToast(t('a'));
    vi.advanceTimersByTime(5_000);
    pauseToasts(true);
    vi.advanceTimersByTime(60_000);
    expect(front()).toBe('a');
    pauseToasts(false);
    vi.advanceTimersByTime(2_999);
    expect(front()).toBe('a');
    vi.advanceTimersByTime(1);
    expect(front()).toBe(null);
  });

  it('holds a newer toast too when it arrives under the pointer', () => {
    addToast(t('a'));
    pauseToasts(true);
    addToast(t('b'));
    vi.advanceTimersByTime(60_000);
    expect(front()).toBe('b');
    pauseToasts(false);
    vi.advanceTimersByTime(LIFE_MS);
    expect(front()).toBe('a');
  });
});
