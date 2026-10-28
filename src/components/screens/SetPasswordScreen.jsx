/**
 * Setting a password from an emailed link — invite or reset, same screen.
 *
 * ## Where it sits
 *
 * Before the auth gate, because its whole audience is people who cannot sign
 * in: someone invited who has no password yet, or someone who has forgotten
 * theirs. There is no router in this app, so App.jsx checks the URL fragment
 * and renders this instead of the login screen when a token is present.
 *
 * ## Why it borrows LoginScreen's classes
 *
 * This is the same moment in the same journey and it should look like it. The
 * split shell, the field boxes, the pill button and the eye toggle are all
 * LoginScreen's, so this needs almost no CSS of its own and cannot drift away
 * from the sign-in page it stands in for.
 *
 * ## Confirm-password is here and nowhere else
 *
 * LoginScreen has no per-field validation and does not need any — a wrong
 * password is answered by the server. Here a typo is unrecoverable: the token
 * is single-use, so a mistyped password burns the link and locks the person
 * out until an admin sends another. That earns the one extra field.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { verifySetupToken, completeSetup, requestPasswordReset } from "../../api/account";
import { firstMessage } from "../../lib/formErrors";
import { clearSetupHash } from "../../lib/setupLink";
import "./LoginScreen.scss";
import "./SetPasswordScreen.scss";

const MIN_LENGTH = 12;

export default function SetPasswordScreen({ token, onDone }) {
  const { reload } = useAuth();

  // checking | invalid | throttled | ready | saving
  const [state, setState] = useState("checking");
  // Bumped to re-run the check when somebody presses "try again".
  const [attempt, setAttempt] = useState(0);
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");

  // The "ask for a new link" fallback, shown once a link has expired.
  const [resendEmail, setResendEmail] = useState("");
  const [resendDone, setResendDone] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);

  /*
   * A FAILED CHECK IS NOT THE SAME AS A DEAD LINK.
   *
   * This used to send every rejection to "invalid", whose screen says the link
   * has expired and offers to mail a new one. When the rejection was a 429 that
   * was false twice over: the link was fine, and the offer spends the reset-mail
   * budget — so the one action the screen suggested made the situation worse.
   * Rate limiting on this path was the whole of the reported bug (the server
   * side is fixed in middleware/rateLimiter.ts), and a screen that lies about
   * why it failed would have hidden it.
   *
   * Only a server that actually answered "not valid" means expired. Everything
   * else is this request failing, and the honest offer is to try it again.
   */
  useEffect(() => {
    let cancelled = false;
    setState("checking");
    verifySetupToken(token)
      .then((data) => {
        if (cancelled) return;
        if (!data?.valid) { setState("invalid"); return; }
        setInfo(data);
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setState(err?.status === 429 ? "throttled" : "invalid");
      });
    return () => { cancelled = true; };
  }, [token, attempt]);

  const retryCheck = useCallback(() => setAttempt((n) => n + 1), []);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;

  async function handleSubmit(e) {
    e.preventDefault();
    if (state === "saving" || !password || password !== confirm || password.length < MIN_LENGTH) return;
    setState("saving");
    setError("");
    try {
      await completeSetup(token, password);
      // The server set the cookies and returned a token, which the api module
      // has already applied — so this lands straight in the app rather than
      // asking for the password that was just chosen.
      clearSetupHash();
      onDone?.();
      await reload();
    } catch (err) {
      setError(firstMessage(err, "password", "Could not set your password."));
      setState("ready");
    }
  }

  async function handleResend(e) {
    e.preventDefault();
    if (resendBusy || !resendEmail) return;
    setResendBusy(true);
    try {
      await requestPasswordReset(resendEmail.trim());
    } catch {
      /* The server answers the same way regardless; so does this. */
    } finally {
      setResendBusy(false);
      setResendDone(true);
    }
  }

  return (
    <div className="login">
      <div className="login__shell">
        <div className="login__panel">
          <div className="login__brand">
            <img className="login__mark" src="/samad-logo.svg" alt="" width="38" height="38" />
            <span className="login__wordmark">SAMAD RESOURCES</span>
          </div>

          {state === "checking" && (
            <>
              <h1 className="login__title">Just a moment.</h1>
              <p className="login__sub">Checking your link…</p>
            </>
          )}

          {state === "throttled" && (
            <>
              <h1 className="login__title">Just a moment.</h1>
              <p className="login__sub">
                The server is turning away requests from your network right now.
                Your link is fine, it has not been used and it has not expired.
                Wait a minute and try again.
              </p>
              {/* Deliberately NOT the "send a new link" form. A new link would
                  revoke the perfectly good one in their inbox and spend the
                  reset-mail budget, for a problem that is neither. */}
              <button className="login__submit" type="button" onClick={retryCheck}>
                Try again
              </button>
            </>
          )}

          {state === "invalid" && (
            <>
              <h1 className="login__title">This link has expired.</h1>
              <p className="login__sub">
                Set-up links can only be used once, and they do not last forever.
                Enter your email and we will send a new one.
              </p>

              <form className="login__form" onSubmit={handleResend} noValidate>
                <label className="login__field">
                  <span className="login__label">Email</span>
                  <input
                    className="login__input"
                    type="email"
                    name="email"
                    autoComplete="username"
                    value={resendEmail}
                    onChange={(e) => setResendEmail(e.target.value)}
                    disabled={resendBusy || resendDone}
                    required
                  />
                </label>

                <div className="login__error" role="status" aria-live="polite">
                  {resendDone ? "If that address has an account, a new link is on its way." : ""}
                </div>

                <button
                  className="login__submit"
                  type="submit"
                  disabled={resendBusy || resendDone || !resendEmail}
                  aria-busy={resendBusy || undefined}
                >
                  {resendBusy ? "Sending…" : "Send a new link"}
                </button>
              </form>
            </>
          )}

          {(state === "ready" || state === "saving") && (
            <>
              <h1 className="login__title">
                {info?.purpose === "RESET" ? "Choose a new password." : "Welcome, set your password."}
              </h1>
              <p className="login__sub">
                {info?.fullName ? `Signing in as ${info.fullName}` : "Choose a password to finish setting up your account."}
                {info?.email ? ` (${info.email})` : ""}
              </p>

              <form className="login__form" onSubmit={handleSubmit} noValidate>
                <label className="login__field">
                  <span className="login__label">New password</span>
                  <span className="login__pwwrap">
                    <input
                      className="login__input login__input--pw"
                      type={showPw ? "text" : "password"}
                      name="newPassword"
                      autoComplete="new-password"
                      autoFocus
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={state === "saving"}
                      required
                    />
                    {/* type="button": a bare button in a form submits it. */}
                    <button
                      className="login__eye"
                      type="button"
                      onClick={() => setShowPw((v) => !v)}
                      aria-label={showPw ? "Hide password" : "Show password"}
                      aria-pressed={showPw}
                      disabled={state === "saving"}
                    >
                      {showPw ? "Hide" : "Show"}
                    </button>
                  </span>
                </label>

                <label className="login__field">
                  <span className="login__label">Confirm password</span>
                  <input
                    className="login__input"
                    type={showPw ? "text" : "password"}
                    name="confirmPassword"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    disabled={state === "saving"}
                    required
                  />
                </label>

                {/* One live region for every failure, server or local — the
                    reserved height keeps the button from hopping. */}
                <div className="login__error" role="alert" aria-live="polite">
                  {error
                    || (mismatch ? "The two passwords do not match." : "")
                    || (tooShort ? `Use at least ${MIN_LENGTH} characters.` : "")}
                </div>

                <button
                  className="login__submit"
                  type="submit"
                  disabled={state === "saving" || !password || password !== confirm || password.length < MIN_LENGTH}
                  aria-busy={state === "saving" || undefined}
                >
                  {state === "saving" ? "Setting…" : "Set password and sign in"}
                </button>
              </form>

              <p className="login__foot">
                A passphrase of a few words is easier to remember and harder to guess.
              </p>
            </>
          )}
        </div>

        <div className="login__hero" aria-hidden="true">
          <div className="login__hero-copy">
            <span className="login__hero-title">One fleet, one view</span>
            <span className="login__hero-sub">
              Positions, fuel and haulage kept in step across every site.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
