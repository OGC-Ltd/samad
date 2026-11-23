import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertsViewFor, receiveServerToast, toastCopyText } from './serverToasts';
import { resetToasts, toastsSnapshot } from './toasts';
import { onAlertsRequest, requestAlertsView, takeAlertsRequest } from './alertsRequest';

const card = (over = {}) => ({
  id: 'pop-1', kind: 'alarm', level: 'critical', title: 'KDT 953D: Phone Use',
  body: 'FRED SIMIYU · 35 km/h · 11:16', sound: true,
  data: { alarm: 'phone_use', plate: 'KDT 953D', eventId: 'e1', count: 1 },
  ...over,
});

describe('receiveServerToast', () => {
  beforeEach(() => { vi.useFakeTimers(); resetToasts(); });
  afterEach(() => { resetToasts(); vi.useRealTimers(); });

  it('queues the card and sounds when the server says so', () => {
    const sound = vi.fn();
    expect(receiveServerToast(card(), { sound })).toBe(true);
    expect(toastsSnapshot().front.id).toBe('pop-1');
    expect(sound).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a silent card (No Seatbelt)', () => {
    const sound = vi.fn();
    receiveServerToast(card({ id: 'pop-2', sound: false, data: { alarm: 'no_seatbelt' } }), { sound });
    expect(sound).not.toHaveBeenCalled();
  });

  it('shows a card once, however often the stream repeats it', () => {
    const sound = vi.fn();
    receiveServerToast(card(), { sound });
    expect(receiveServerToast(card(), { sound })).toBe(false);
    expect(sound).toHaveBeenCalledTimes(1);
    expect(toastsSnapshot().behind).toBe(0);
  });

  it('ignores malformed frames', () => {
    for (const bad of [null, 'x', {}, { id: 'a' }, { title: 'no id' }]) {
      expect(receiveServerToast(bad, { sound: vi.fn() })).toBe(false);
    }
    expect(toastsSnapshot().front).toBe(null);
  });
});

describe('alertsViewFor', () => {
  it('opens each camera alarm on its own list', () => {
    expect(alertsViewFor(card())).toEqual({ kind: 'camera', alarm: 'phone_use' });
    expect(alertsViewFor(card({ data: { alarm: 'no_seatbelt' } }))).toEqual({ kind: 'camera', alarm: 'no_seatbelt' });
    expect(alertsViewFor(card({ data: { alarm: 'driver_distracted' } }))).toEqual({ kind: 'camera', alarm: 'driver_distracted' });
  });
  it('opens overspeeding on the overspeeding list', () => {
    expect(alertsViewFor(card({ data: { alarm: 'overspeeding' } }))).toEqual({ kind: 'speeding', alarm: '' });
  });
  it('opens a summary on the camera list as a whole', () => {
    expect(alertsViewFor({ kind: 'alarms', data: { counts: { phone_use: 3 } } })).toEqual({ kind: 'camera', alarm: '' });
  });
});

it('copies the title and the details on one line', () => {
  expect(toastCopyText(card())).toBe('KDT 953D: Phone Use · FRED SIMIYU · 35 km/h · 11:16');
  expect(toastCopyText({ title: 'X' })).toBe('X');
});

describe('alertsRequest', () => {
  it('holds a request until the page takes it, once', () => {
    requestAlertsView({ kind: 'camera', alarm: 'phone_use' });
    expect(takeAlertsRequest()).toMatchObject({ kind: 'camera', alarm: 'phone_use' });
    expect(takeAlertsRequest()).toBe(null);
  });
  it('tells an open page straight away', () => {
    const heard = vi.fn();
    const off = onAlertsRequest(heard);
    requestAlertsView({ kind: 'speeding' });
    off();
    requestAlertsView({ kind: 'camera' });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(takeAlertsRequest()).toMatchObject({ kind: 'camera', alarm: '' });
  });
});
