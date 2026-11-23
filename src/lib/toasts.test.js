import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BEHIND, addToast, dismissAllToasts, dismissToast, resetToasts, subscribeToasts, toastsSnapshot } from './toasts';

const t = (id) => ({ id, kind: 'alarm', level: 'critical', title: id, body: '' });
const front = () => toastsSnapshot().front?.id ?? null;

describe('pop-up queue', () => {
  beforeEach(() => { vi.useFakeTimers(); resetToasts(); });
  afterEach(() => { resetToasts(); vi.useRealTimers(); });

  it('puts the newest in front and keeps the rest behind it', () => {
    for (const id of ['a', 'b', 'c']) addToast(t(id));
    expect(front()).toBe('c');
    expect(toastsSnapshot().behind).toBe(2);
  });

  it('keeps a card until it is closed: no timer', () => {
    addToast(t('a'));
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(front()).toBe('a');
  });

  it('brings the next newest forward when the front one is closed', () => {
    for (const id of ['a', 'b', 'c']) addToast(t(id));
    dismissToast('c');
    expect(front()).toBe('b');
    expect(toastsSnapshot().behind).toBe(1);
    dismissToast('a'); // one behind can be closed too
    expect(front()).toBe('b');
    expect(toastsSnapshot().behind).toBe(0);
  });

  it('closes them all at once', () => {
    for (const id of ['a', 'b', 'c']) addToast(t(id));
    dismissAllToasts();
    expect(front()).toBe(null);
    expect(toastsSnapshot().behind).toBe(0);
  });

  it('shows a card once, even if the stream sends it again', () => {
    expect(addToast(t('a'))).toBe(true);
    expect(addToast(t('a'))).toBe(false);
    dismissToast('a');
    expect(addToast(t('a'))).toBe(false); // closed stays closed
    expect(front()).toBe(null);
  });

  it('drops the oldest beyond MAX_BEHIND', () => {
    for (let i = 0; i < MAX_BEHIND + 5; i++) addToast(t(`x${i}`));
    expect(toastsSnapshot().behind).toBe(MAX_BEHIND);
    expect(front()).toBe(`x${MAX_BEHIND + 4}`);
  });

  it('tells listeners of every change', () => {
    const heard = vi.fn();
    const off = subscribeToasts(heard);
    addToast(t('a'));
    dismissToast('a');
    dismissAllToasts(); // nothing left: no news
    off();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
