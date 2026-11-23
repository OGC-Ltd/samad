// A `toast` frame from the server (hooks/useFleetLive): queued for the stack
// (lib/toasts), with a short tone when the server says it should sound
// (server/popups.go: every pop-up alarm but No Seatbelt). The server has
// already grouped the bursts and sends cards only to those who may read
// alerts; this does not judge them again.

import { addToast } from './toasts';

let audio = null;
function beep() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.6);
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.65);
  } catch { /* no sound in this browser, or not allowed before a click */ }
}

/** Returns whether the toast was queued (false: malformed, or seen already). */
export function receiveServerToast(toast, { sound = beep } = {}) {
  if (!toast || typeof toast !== 'object' || typeof toast.title !== 'string') return false;
  if (!addToast(toast)) return false;
  if (toast.sound) sound();
  return true;
}

/**
 * Where Open takes a pop-up on the Alerts page: the alarm's own list.
 * Overspeeding is its own kind; the three camera alarms are the Camera kind
 * with that alarm picked (the camera alarm filter, #39). A summary card opens
 * the camera list as a whole.
 */
export function alertsViewFor(toast) {
  const alarm = toast?.data?.alarm ?? '';
  if (alarm === 'overspeeding') return { kind: 'speeding', alarm: '' };
  if (['no_seatbelt', 'phone_use', 'driver_distracted'].includes(alarm)) return { kind: 'camera', alarm };
  return { kind: 'camera', alarm: '' };
}

/** The card's words for Copy: one line to paste into a chat. */
export function toastCopyText(toast) {
  return [toast?.title, toast?.body].filter(Boolean).join(' · ');
}
