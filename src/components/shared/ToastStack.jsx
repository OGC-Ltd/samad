/*
 * The pop-up stack, mounted once for the whole app: the bottom-corner cards
 * for Phone Use, No Seatbelt, Driver Distracted and Overspeeding (operator,
 * 2026-11-23: "like the alerts of the unauthorised stops" in raitrack, the
 * same card). The server groups the bursts (server/popups.go) and sends them
 * down the live stream (lib/serverToasts). Last in, first out: only the
 * newest is drawn and the next comes forward when it is closed (lib/toasts).
 * Unlike raitrack's, a card stays until someone closes it (operator,
 * 2026-11-23), so the card says how many wait behind it and can close them
 * all.
 *
 * A pop-up must never take the page down with it: any error inside is caught
 * here and the stack simply draws nothing.
 */

import { Component, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAppActions } from '../../context/AppContext';
import { dismissAllToasts, dismissToast, subscribeToasts, toastsSnapshot } from '../../lib/toasts';
import { alertsViewFor, toastCopyText } from '../../lib/serverToasts';
import { requestAlertsView } from '../../lib/alertsRequest';
import { copyText } from '../../lib/copyText';
import './ToastStack.css';

const ALARM_ICON = {
  phone_use: 'ti-device-mobile',
  no_seatbelt: 'ti-car',
  driver_distracted: 'ti-eye-off',
  overspeeding: 'ti-gauge',
};

function icon(t) {
  if (t.kind === 'alarms') return 'ti-bell-ringing';
  return ALARM_ICON[t.data?.alarm] ?? (t.level === 'info' ? 'ti-bell' : 'ti-alert-triangle');
}

/** Copy the card's words, beside Open: the icon turns to a tick, or a warning when refused. */
function CopyCard({ text }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 1600 : 2600);
  };
  const words = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy this alert';
  return (
    <button type="button" className={`tst__copy tst__copy--${state}`} onClick={onCopy} title={words} aria-label={words}>
      <i className={`ti ${state === 'copied' ? 'ti-check' : state === 'failed' ? 'ti-alert-triangle' : 'ti-copy'}`} aria-hidden="true" />
    </button>
  );
}

function Toast({ t, behind }) {
  const { setDesktopActiveTab } = useAppActions();
  const open = () => {
    requestAlertsView(alertsViewFor(t));
    setDesktopActiveTab('alerts');
    dismissToast(t.id);
  };
  return (
    <div className={`tst tst--${t.level}`} role={t.level === 'info' || t.level === 'success' ? 'status' : 'alert'}>
      <span className="tst__mark" aria-hidden="true"><i className={`ti ${icon(t)}`} /></span>
      <div className="tst__text">
        <b>{t.title}</b>
        {t.body && <span>{t.body}</span>}
        <div className="tst__acts">
          <button type="button" className="tst__open" onClick={open}>Open</button>
          {t.kind === 'alarm' && <CopyCard text={toastCopyText(t)} />}
        </div>
      </div>
      <button type="button" className="tst__x" aria-label="Close" title="Close" onClick={() => dismissToast(t.id)}>
        <i className="ti ti-x" aria-hidden="true" />
      </button>
      {behind > 0 && (
        <div className="tst__more">
          <span>+{behind} more</span>
          <button type="button" className="tst__all" onClick={dismissAllToasts}>Close all</button>
        </div>
      )}
    </div>
  );
}

function Stack() {
  const { front, behind } = useSyncExternalStore(subscribeToasts, toastsSnapshot, toastsSnapshot);
  if (!front) return null;
  return (
    <div className="tst-stack" role="region" aria-label="Alert pop-ups">
      {/* Keyed by id: each card that comes forward slides in. */}
      <Toast key={front.id} t={front} behind={behind} />
    </div>
  );
}

/** Draws nothing, rather than an error box, if a card ever fails to draw. */
class Quiet extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[ToastStack] a pop-up failed to draw:', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function ToastStack() {
  return <Quiet><Stack /></Quiet>;
}
