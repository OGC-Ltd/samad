// The sign-in gate.
//
// Deliberately says as little as possible about why a sign-in failed. The
// server answers unknown-email, no-password-set and wrong-password with one
// identical message so nobody can probe which addresses exist, and repeating a
// friendlier guess here would undo that.

import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { requestPasswordReset } from "../../api/account";
import { getFleetPulse } from "../../api/publicStats";
import { readCache, writeCache } from "../../services/cache";
import {
  PULSE_CACHE_KEY, usablePulse, nextPollDelay, mergePulse,
} from "../../lib/fleetPulse";
import { versionLabel, copyrightLabel, buildDetail } from "../../lib/version";
import "./LoginScreen.scss";

/** At or above this share of the fleet, the platform is at its busiest and the
 *  card says so. Chosen by the operator, not derived — it is a threshold, and a
 *  threshold nobody picked is a number pretending to be a finding. */
const BUSY_SHARE = 80;

/**
 * Units in transit across every organisation, or null.
 *
 * The COUNT is the server's: `/fleet-pulse` runs one query over every active
 * vehicle on the platform, with no organisation filter in it, so the figure is
 * already the sum — Sukari's movers plus Menengai's plus West Kenya's plus
 * Mufindi's — and the definition of "moving" is the dashboard's own, so the
 * landing page and the header cannot disagree about what they are counting.
 *
 * This hook is about the three moments that figure is looked at, all of which
 * used to show something other than the current sum. See lib/fleetPulse, which
 * holds the rules and is where they are tested.
 *
 *   FIRST RENDER / REFRESH  seeded synchronously from the last figure this
 *                           device was told, so the count is on screen in the
 *                           first paint rather than arriving after it. A stale
 *                           seed is dropped rather than shown — `usablePulse`.
 *
 *   IDLING                  the next read is aimed at the moment the SERVER's
 *                           cache expires, not at a fixed cadence from whenever
 *                           this tab opened. Every device is aiming at the same
 *                           instant, because they are reading the same `asOf`,
 *                           so they converge on each new figure together
 *                           instead of drifting a window apart. A tab left open
 *                           against a server that has stopped answering lets
 *                           the figure go rather than presenting last night's
 *                           traffic as live.
 *
 * Still refetched when the tab becomes visible, and still null on every kind
 * of failure — a server too old for the route, one under load, a browser
 * offline. The card is built to say something true without a number.
 */
function useFleetPulse() {
  // Synchronous, so the first paint already has the figure. `useState(fn)` and
  // not `useState(read())` — the initialiser must not run on every render.
  const [pulse, setPulse] = useState(() => usablePulse(readCache(PULSE_CACHE_KEY)));

  useEffect(() => {
    let live = true;
    let timer = null;
    const controller = new AbortController();

    const read = async () => {
      const next = await getFleetPulse(controller.signal);
      if (!live) return;
      if (next) writeCache(PULSE_CACHE_KEY, next);
      // A failed read leaves the last good figure standing — one bad poll is
      // not the fleet stopping. A run of them long enough to make that figure
      // stale drops it; see mergePulse.
      setPulse(prev => mergePulse(prev, next));
      // Scheduled from the ANSWER, so the next read lands just after the
      // server lets go of this value. On a failure `next` is null and this
      // falls back to the plain window rather than hammering.
      timer = setTimeout(read, nextPollDelay(next));
    };

    read();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // A backgrounded tab's timers are throttled and may not have fired for
      // minutes, so coming back is its own reason to ask — and the pending
      // timer is cleared first, or returning to a tab repeatedly would leave a
      // timer per visit all polling the same route.
      clearTimeout(timer);
      read();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return pulse;
}

export default function LoginScreen() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState(false);

  // The reset panel swaps the body of THIS card rather than being its own
  // screen — there is no router, and a second screen for one email field is a
  // navigation problem invented to solve a form problem.
  const [mode, setMode] = useState("signin"); // signin | reset
  const pulse = useFleetPulse();
  const busy = pulse != null && pulse.share >= BUSY_SHARE;
  const [resetSent, setResetSent] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  async function handleReset(e) {
    e.preventDefault();
    if (resetBusy || !email) return;
    setResetBusy(true);
    try {
      await requestPasswordReset(email.trim());
    } catch {
      // The server answers identically whatever it finds, so there is nothing
      // here worth branching on — and a visible failure would leak that the
      // address was special in some way.
    } finally {
      setResetBusy(false);
      setResetSent(true);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (pending || !email || !password) return;
    setPending(true);
    try {
      await login(email.trim(), password);
    } finally {
      // On success this component unmounts, so the state set is a no-op; on
      // failure it is what re-enables the button.
      setPending(false);
    }
  }

  return (
    <div className="login">
      <div className="login__shell">
        <div className="login__panel">
          <div className="login__brand">
            {/* alt="" — decorative: the wordmark beside it already names the
                company, so announcing the mark too would just repeat it. */}
            <img className="login__mark" src="/samad-logo.svg" alt="" width="38" height="38" />
            <span className="login__wordmark">SAMAD RESOURCES</span>
          </div>

          {mode === "reset" ? (
            <>
              <h1 className="login__title">Reset your password.</h1>
              <p className="login__sub">
                Enter the email you sign in with and we will send you a link to
                choose a new password.
              </p>

              <form className="login__form" onSubmit={handleReset} noValidate>
                <label className="login__field">
                  <span className="login__label">Email</span>
                  <input
                    className="login__input"
                    type="email"
                    name="email"
                    autoComplete="username"
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={resetBusy || resetSent}
                    required
                  />
                </label>

                {/* The server answers identically for a known and an unknown
                    address, so this copy is deliberately non-committal — it
                    must not become a way to ask who has an account. */}
                <div className="login__error" role="status" aria-live="polite">
                  {resetSent ? "If that address has an account, a reset link is on its way." : ""}
                </div>

                <button
                  className="login__submit"
                  type="submit"
                  disabled={resetBusy || resetSent || !email}
                >
                  {resetBusy ? "Sending…" : "Send reset link"}
                </button>

                <button
                  className="login__link"
                  type="button"
                  onClick={() => { setMode("signin"); setResetSent(false); }}
                >
                  Back to sign in
                </button>
              </form>
            </>
          ) : (
          <>
          <h1 className="login__title">This is where the day&rsquo;s work starts.</h1>
          <p className="login__sub">
            Live positions, fuel and haulage for your fleet. Sign in to pick up
            where the shift left off.
          </p>

          <form className="login__form" onSubmit={handleSubmit} noValidate>
            <label className="login__field">
              <span className="login__label">Email</span>
              <input
                className="login__input"
                type="email"
                name="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending}
                required
              />
            </label>

            <label className="login__field">
              <span className="login__label">Password</span>
              <span className="login__pwwrap">
                <input
                  className="login__input login__input--pw"
                  type={showPw ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={pending}
                  required
                />
                {/* type="button" matters: a bare button in a form submits it. */}
                <button
                  className="login__eye"
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  aria-pressed={showPw}
                  disabled={pending}
                >
                  <EyeIcon off={showPw} />
                </button>
              </span>
            </label>

            {/* aria-live so a screen reader announces the failure, which is
                otherwise a silent visual change after the button re-enables. */}
            <div className="login__error" role="alert" aria-live="polite">
              {error ?? ""}
            </div>

            <button
              className="login__submit"
              type="submit"
              disabled={pending || !email || !password}
            >
              {pending ? "Signing in…" : "Sign in"}
            </button>

            {/* type="button" — inside a form, a bare button submits it. */}
            <button
              className="login__link"
              type="button"
              onClick={() => { setMode("reset"); setResetSent(false); }}
            >
              Forgotten your password?
            </button>
          </form>

          <p className="login__foot">
            No account? Your organisation&rsquo;s administrator creates one.
            <br />
            Invited but never signed in? Use the link in your invitation email.
          </p>
          </>
          )}

          {/* Every mode (sign-in and reset): "which version is this?" is the
              first support question, and it is asked before signing in too. */}
          <p className="login__version" title={buildDetail()}>
            {versionLabel()} · {copyrightLabel()}
          </p>
        </div>

        {/* Decorative only. Static copy — nothing here talks to the API, since
            this screen renders before there is a session, and a stat slot with
            no real number to put in it is worse than no stat slot. */}
        <div className="login__hero" aria-hidden="true">
          {/* Cut into the corner of the photograph rather than laid on top of
              it: the ring around it is the sheet's own colour, and the hero
              clips it on the two outer sides, so what is left reads as a hole
              in the picture. A card with a drop shadow would have been a
              sticker.

              The figure is deliberately not a percentage. Nothing on this
              screen can fetch one — it renders before there is a session — and
              a number invented to fill the shape would be the one dishonest
              thing on a page whose whole job is to be trusted with a password. */}
          <div className={`login__stat${busy ? " login__stat--busy" : ""}`}>
            <span className="login__stat-figure">
              <span className="login__pulse" />
              {pulse ? pulse.inTransit.toLocaleString() : "Live"}
            </span>
            <span className="login__stat-label">
              {pulse
                /* The share is what turns a count into a fact. "312 units
                   moving" means nothing without knowing whether that is most
                   of the fleet or a tenth of it. */
                ? <>units in transit · <strong className="login__stat-share">{pulse.share}%</strong> of the fleet</>
                : "Every unit, every site, one screen"}
            </span>
            {busy && <span className="login__stat-flag">Peak movement</span>}
          </div>

          <div className="login__hero-copy">
            <span className="login__hero-title">One fleet, one view</span>
            <span className="login__hero-sub">
              Positions, fuel and haulage kept in step across every site.
            </span>
          </div>

          <div className="login__tags">
            <span className="login__tag login__tag--ok"><GpsIcon />Live tracking</span>
            <span className="login__tag login__tag--info"><FuelIcon />Fuel</span>
            <span className="login__tag login__tag--warn"><HaulIcon />Haulage</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* The three badge marks.
 *
 * Each animates the ONE thing its subject actually does — a fix repeating, a
 * tank filling, a load moving — rather than wobbling to prove it is animated.
 * All three run on transform and opacity only, and all three stop under
 * `prefers-reduced-motion` (see the stylesheet), where they still read as
 * icons because none of them depends on motion to be legible.
 *
 * `aria-hidden` on all of them: the word beside each one already names it, and
 * a screen reader announcing "image, Live tracking, Live tracking" is worse
 * than silence. They also sit inside the hero, which is aria-hidden entire. */

/** A fix being taken: the ring goes out, the dot stays put. */
function GpsIcon() {
  return (
    <svg className="login__ic login__ic--gps" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle className="login__ic-ring" cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle className="login__ic-dot" cx="8" cy="8" r="2.1" fill="currentColor" />
    </svg>
  );
}

/** A tank filling: the level rises inside the drop, then resets. The drop's
 *  outline never moves, so the icon is a drop at every frame. */
function FuelIcon() {
  const drop = "M8 1.8c0 0 4.6 5 4.6 7.7a4.6 4.6 0 1 1-9.2 0C3.4 6.8 8 1.8 8 1.8Z";
  return (
    <svg className="login__ic login__ic--fuel" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <defs>
        {/* clipPath, not a mask: the level is a hard line, which is what a
            liquid surface in a 13px icon has to be to read at all. */}
        <clipPath id="login-fuel-clip"><path d={drop} /></clipPath>
      </defs>
      <path d={drop} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect className="login__ic-level" x="2" y="4" width="12" height="11" fill="currentColor" clipPath="url(#login-fuel-clip)" />
    </svg>
  );
}

/** A load moving: the road runs under the truck rather than the truck bouncing
 *  on it — the cab stays still, which is what lets a 13px shape stay a truck. */
function HaulIcon() {
  return (
    <svg className="login__ic login__ic--haul" viewBox="0 0 16 16" width="14" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
        <path d="M1.4 4.2h7.2v6H1.4z" />
        <path d="M8.6 6.4h2.9l2.1 2.2v1.6H8.6z" />
      </g>
      <circle cx="4.4" cy="11.4" r="1.5" fill="currentColor" />
      <circle cx="11.4" cy="11.4" r="1.5" fill="currentColor" />
      <g className="login__ic-road" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M0 14h4" />
        <path d="M6 14h4" />
        <path d="M12 14h4" />
      </g>
    </svg>
  );
}

function EyeIcon({ off }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.9" />
      {off ? (
        <path
          d="M4 20 20 4"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}
