/**
 * The account page.
 *
 * ## The shape
 *
 * A profile page, not a settings form: a cover strip, a centred avatar and
 * name, a line saying what this person is and where, then a tab bar over a
 * two-column body with a card rail down the right. That shape came from a
 * reference design and the reason it works here is that the first question
 * somebody brings to this page is "what am I", not "what can I change".
 *
 * ## Tabs, and the one thing they must not hide
 *
 * This page used to argue against tabs, and the argument was sound: hiding
 * access behind a click is wrong when access is what people come to read.
 *
 * Tabs are here anyway, with that argument answered rather than ignored. The
 * right-hand rail is OUTSIDE the tabs and always rendered, and it carries the
 * access summary — how many organisations, how many roles, what you may do in
 * the one that is open. So the question that must not need a click does not
 * need one, and the tabs only decide which set of controls sits beside it.
 *
 * ## Nothing here is invented
 *
 * The reference is a social profile: followers, karma, badges, a bio somebody
 * typed. None of that exists on this server and none of it is faked. Every
 * slot is filled from what the account API and /me actually return —
 * organisations, roles, permissions, dates, status — and the two counts that
 * sit where the reference put Followers and Following are Organisations and
 * Roles. A number on this page is a number you could go and verify.
 *
 * ## What you cannot change here
 *
 * Email and role. Both are shown, because "what am I" is half the reason to
 * open this page, and both are read-only with a line saying who can change
 * them. Stating that is better than an absence the reader has to interpret.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useAppFields, useAppActions, useTheme } from "../../context/AppContext";
import { accessIn } from "../../hooks/usePermissions";
import { companyMark } from "../../lib/companyLogos";
import { NAV_ITEMS } from "../layout/SidePanel";
import { useWayBack, labelFor } from "../../hooks/useWayBack";
import {
  updateDisplayName, changePassword, getAccountProfile, revokeAllSessions,
} from "../../api/account";
import { firstMessage, isMissingEndpoint } from "../../lib/formErrors";
import { uniqueRoles as distinctRoles, roleNames } from "../../lib/accountRoles";
import LoadError from "../shared/LoadError";
import { pushState, enablePush, disablePush } from "../../lib/pushNotifications";
import "./AccountScreen.css";

const MIN_LENGTH = 12;

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "security", label: "Security" },
  { key: "access", label: "Access" },
];

/** "3 Sep 2026", or a dash. Dates here are facts, not durations. */
function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "Jun 2020" — the reference's joined line, which wants no day. */
function fmtMonth(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** Up to two initials from a display name, falling back to the email. */
/**
 * One organisation, as a mark.
 *
 * The chips and the access list used to open with the organisation's INITIALS
 * on a dark disc, which put "WK" in front of "West Kenya Sugar Ltd" and "MP"
 * in front of "Mufindi Paper Mills Ltd" — an abbreviation of the word sitting
 * next to it, which is the one thing a mark beside a name must not be. The
 * tenants have real artwork and the roster already draws it; this is the same
 * device in the place where somebody reads their own access.
 *
 * `companyMark` keys off the organisation `code` the profile carries, so it
 * resolves for the tenants with artwork on file and returns null for the rest.
 * The initials stay for those — a blank disc beside a name would say less
 * than the abbreviation did.
 */
function OrgMark({ org, className = "" }) {
  const mark = org ? companyMark(org) : null;
  if (mark) {
    return <img className={"acct-orgmark acct-orgmark--logo " + className} src={mark} alt="" />;
  }
  return (
    <span className={"acct-orgmark acct-orgmark--letter " + className} aria-hidden="true">
      {initialsOf(org?.name, org?.code)}
    </span>
  );
}

function initialsOf(name, email) {
  const source = String(name ?? "").trim() || String(email ?? "").trim();
  if (!source) return "·";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * "map:filter" → "Map filter".
 *
 * Slugs are what the server enforces and what a bug report needs to quote, so
 * the raw slug stays on the chip's `title`. The label is for reading a wall of
 * forty of them, which is what the permission list actually is.
 */
function prettySlug(slug) {
  const words = String(slug).replace(/[:_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The colour a user status is entitled to.
 *
 * The three values are the whole `UserStatus` enum (prisma/schema.prisma), and
 * the tones are the ones the user roster already uses for the same three
 * facts — active is good, suspended is a warning, terminated is critical. The
 * vocabulary is shared deliberately: the same word must not be green on one
 * screen and amber on another, or the colour stops carrying meaning and
 * becomes decoration.
 *
 * The HUES are this page's own rather than the roster's `--ua-*` tokens.
 * Those are pale (#86efac and friends) because they sit on a dark panel; on
 * this white page they would be unreadable. Same meaning, legible contrast.
 *
 * An unrecognised value gets the neutral tone rather than a guess. A status
 * this build has not heard of is exactly the case where inventing a colour
 * would be worse than admitting none.
 */
const STATUS_TONE = { ACTIVE: "ok", SUSPENDED: "warn", TERMINATED: "crit" };

function StatusPill({ status }) {
  if (!status) return null;
  const tone = STATUS_TONE[String(status).toUpperCase()] ?? "unknown";
  return <span className={`acct-status acct-status--${tone}`}>{status}</span>;
}

export default function AccountScreen() {
  const { user, orgs, isPlatform, reload } = useAuth();
  const { activeCompanyId, desktopActiveTab } = useAppFields("activeCompanyId", "desktopActiveTab");
  const { setAccountOpen } = useAppActions();
  const { themePref, setThemePref } = useTheme();

  const [tab, setTab] = useState("profile");
  /* The permission list runs to dozens of slugs and is the least-read thing on
     the page — it answers "may I", which people check once, not "who am I",
     which is why they came. Capped to a first row and opened on request. */
  const [allPerms, setAllPerms] = useState(false);

  const [profile, setProfile] = useState(null);
  const [access, setAccess] = useState({ organisations: [], platformRoles: [] });
  // Two different failures with two different answers: the endpoint is not on
  // this server yet, or the request genuinely failed. Retrying only helps one.
  const [loadFailed, setLoadFailed] = useState(false);
  const [notDeployed, setNotDeployed] = useState(false);

  const [name, setName] = useState(user?.fullName ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState("");
  const [nameDone, setNameDone] = useState("");

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwDone, setPwDone] = useState("");

  // Push notification on this device (lib/pushNotifications): repair ticket
  // numbers reach the operator and the security heads this way.
  const [push, setPush] = useState("unsupported");
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => { pushState().then(setPush).catch(() => {}); }, []);
  async function choosePush(on) {
    if (pushBusy || !activeCompanyId || (push === "on") === on) return;
    setPushBusy(true);
    try {
      setPush(await (on ? enablePush(activeCompanyId) : disablePush(activeCompanyId)));
    } catch {
      setPush(await pushState().catch(() => "off"));
    } finally {
      setPushBusy(false);
    }
  }

  const [sessionBusy, setSessionBusy] = useState(null);
  const [sessionNote, setSessionNote] = useState("");

  const load = useCallback(async () => {
    setLoadFailed(false);
    setNotDeployed(false);
    try {
      const p = await getAccountProfile();
      setProfile(p?.user ?? null);
      setAccess({ organisations: p?.organisations ?? [], platformRoles: p?.platformRoles ?? [] });
    } catch (err) {
      if (isMissingEndpoint(err)) setNotDeployed(true);
      else setLoadFailed(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submitName(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (nameBusy || !trimmed || trimmed === user?.fullName) return;
    setNameBusy(true); setNameError(""); setNameDone("");
    try {
      await updateDisplayName(trimmed);
      await reload();
      setNameDone("Name updated.");
    } catch (err) {
      setNameError(isMissingEndpoint(err)
        ? "Saving is not available yet, this server does not have the account API."
        : firstMessage(err, "fullName", "Could not update your name."));
    } finally {
      setNameBusy(false);
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    if (pwBusy || !current || !next) return;
    setPwBusy(true); setPwError(""); setPwDone("");
    try {
      await changePassword(current, next);
      setCurrent(""); setNext("");
      setPwDone("Password changed. You were signed out on your other devices.");
      load();
    } catch (err) {
      setPwError(isMissingEndpoint(err)
        ? "Changing your password is not available yet, this server does not have the account API."
        : firstMessage(err, "newPassword", "Could not change your password."));
    } finally {
      setPwBusy(false);
    }
  }

  async function endEverything() {
    setSessionBusy("all"); setSessionNote("");
    try {
      await revokeAllSessions();
      // This ends the CURRENT session too, so there is nothing to stay for —
      // the next request would 401 and bounce to the login screen anyway.
      window.location.reload();
    } catch (err) {
      setSessionNote(firstMessage(err, null, "Could not sign out everywhere."));
      setSessionBusy(null);
    }
  }

  const displayName = (user?.fullName ?? "").trim() || (user?.email ?? "");
  const email = profile?.email ?? user?.email ?? "";
  const homeOrg = profile?.organisation?.name ?? null;
  const joined = fmtMonth(profile?.createdAt);

  /* The permission list for the organisation on screen.
   *
   * Org-scoped on purpose: the same account can be a manager at one site and
   * an operator at another, so a single flat "what you can do" would be a
   * different lie at every company in the switcher. `accessIn` is the same
   * resolver every gated control in the app uses — asking this question a
   * second way is how a page comes to promise something the server refuses. */
  const activeAccess = useMemo(
    () => accessIn(orgs, activeCompanyId),
    [orgs, activeCompanyId],
  );
  /* Where "back" goes, and what it is therefore called — shared with the
     user-accounts page, which needs the same answer from a different shell.
     hooks/useWayBack carries the reasoning; the short version is that the Live
     Map is a permission like any other, so this names whichever screen the
     account can actually open rather than promising one it cannot. */
  const wayBack = useWayBack();

  /* The page this one opened OVER, which is where the blue button goes.
   *
   * It needs no history of its own: this screen is an overlay and does not
   * touch `desktopActiveTab`, so the tab still selected underneath IS the page
   * they were on. Reading it live rather than snapshotting it on mount is
   * deliberate — App corrects a stored tab the account cannot open, and a
   * snapshot taken before that correction would name a screen that is not
   * there any more.
   *
   * Graded anyway, for the moment before that correction lands: an unknown or
   * forbidden tab is not a destination, and naming one would be the same lie
   * the header button was fixed to stop telling. */
  const resume = useMemo(() => {
    const tab = NAV_ITEMS.find((t) => t.key === desktopActiveTab) ?? null;
    if (!tab || !activeAccess.can(tab.permission)) return null;
    return { tab: tab.key, label: labelFor(tab) };
  }, [desktopActiveTab, activeAccess]);

  /* ...but only when it is somewhere ELSE.
   *
   * Coming here from the Live Map, "back to the page you were on" and "back to
   * the fleet" are the same journey, and drawing both was the duplication this
   * replaced. When they coincide the header link is the one that survives: it
   * is always present, on every tab, so the row loses a button rather than the
   * page losing its way out. */
  const showResume = resume !== null && resume.tab !== wayBack.tab;

  /* Closing without moving. The tab underneath is already the destination, so
     this resumes rather than navigates — setting the tab it is already on
     would be a no-op dressed up as a decision. */
  const goResume = useCallback(() => { setAccountOpen(false); }, [setAccountOpen]);

  const goBack = useCallback(() => {
    wayBack.go();
    setAccountOpen(false);
  }, [wayBack, setAccountOpen]);

  // Escape leaves the page — it is reached from a menu, so it behaves like the
  // thing it replaced even though it now fills the screen. It goes out through
  // `goBack` rather than closing on its own, so the key and the button land in
  // the same place; declared after it because a dependency array is read
  // during render, and `goBack` above its own `const` is a TDZ crash.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") goBack(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goBack]);

  const activePerms = useMemo(() => {
    const list = activeAccess.org?.permissions ?? [];
    return [...list].sort();
  }, [activeAccess]);

  /* Eight, which is two short rows at the main column's 704px — measured, not
     assumed; the labels are long enough that a single row holds about five.
     Two rows is enough to show what KIND of thing is in the list, which is all
     a collapsed list owes the reader, and the section comes to 136px instead
     of running past the fold. */
  const PERM_PREVIEW = 8;
  const permsShown = allPerms ? activePerms : activePerms.slice(0, PERM_PREVIEW);
  const permsHidden = activePerms.length - permsShown.length;

  /* The distinct roles this account holds, not one per membership.
   *
   * These two are different questions and only one of them is "Roles". Somebody
   * made system administrator in four organisations holds ONE role; summing the
   * per-org lists called that four, which is the number of ASSIGNMENTS, and
   * reporting it under "Roles held" beside a chip row showing the same name
   * four times made the page look like it could not count.
   *
   * Keyed by slug, because the slug is what the server grants and two orgs can
   * spell the same role's display name differently. `orgs` is carried along so
   * a chip can still say where a role is held — the fact the per-membership
   * count was standing in for, kept as the tooltip it should always have been.
   * A platform role wins the key: it applies everywhere, which is a strictly
   * bigger statement than holding it at one site. */
  /* The DISTINCT roles held, not one per membership — see lib/accountRoles
     for why the key is the displayed name rather than the slug, and
     accountRoles.test.js for the four-organisation case that drove it. */
  const uniqueRoles = useMemo(() => distinctRoles(access), [access]);

  const roleCount = uniqueRoles.length;

  /* The bio line, written from facts rather than typed by anybody.
   *
   * The reference has a paragraph the person wrote about themselves. There is
   * no field for that here and inventing one would mean shipping an input the
   * server cannot store, so this says the true version of the same thing: what
   * you are, and where. */
  const roleSummary = useMemo(() => {
    if (access.platformRoles.length > 0) return roleNames(access.platformRoles);
    const here = access.organisations.find((o) => o.name === homeOrg) ?? access.organisations[0];
    return here?.roles?.length ? roleNames(here.roles) : null;
  }, [access, homeOrg]);

  const notices = (
    <>
      {notDeployed && (
        // NOT a LoadError: "check your connection and try again" is wrong
        // and misleading when the server answered cleanly with a 404.
        <div className="acct-notice" role="status">
          <strong className="acct-notice__title">Account service not available</strong>
          <span className="acct-notice__body">
            This dashboard is talking to an API that does not have the account
            endpoints yet, so your details, devices and access cannot be shown
            and saving will not work. The server needs the current build
            deployed and its migrations run.
          </span>
        </div>
      )}
      {loadFailed && <LoadError label="Account" onRetry={load} />}
    </>
  );

  return (
    <div className="acct-page">
      {/* ── Cover ──────────────────────────────────────────────────────────
          Flat and quiet on purpose. The reference puts a photograph here; a
          fleet account has no image to put in it, and a stock one would be
          decoration pretending to be content. What it is really doing is
          giving the avatar an edge to sit on. */}
      <div className="acct-cover">
        <button type="button" className="acct-cover__back" onClick={goBack}>
          ← {wayBack.label}
        </button>
      </div>

      {/* ── Identity ───────────────────────────────────────────────────── */}
      <header className="acct-id">
        <div className="acct-id__avatar" aria-hidden="true">
          {initialsOf(user?.fullName, user?.email)}
        </div>

        <h1 className="acct-id__name">{displayName}</h1>

        {(roleSummary || homeOrg) && (
          <p className="acct-id__bio">
            {roleSummary ?? "No role assigned"}
            {homeOrg ? <> at <strong>{homeOrg}</strong></> : null}
            {isPlatform && <> · platform administrator, which applies in every organisation</>}
          </p>
        )}

        <p className="acct-id__meta">
          {email}
          {joined ? <> · Joined {joined}</> : null}
          {profile?.status ? <> · <StatusPill status={profile.status} /></> : null}
        </p>

        {/* Where the reference puts Followers and Following. These two are the
            same shape of fact — a count you can click through and check — and
            they are the two numbers this page exists to report. */}
        <div className="acct-id__actions">
          <button
            type="button"
            className="acct-stat"
            onClick={() => setTab("access")}
          >
            <span className="acct-stat__n">{access.organisations.length}</span>
            <span className="acct-stat__k">
              {access.organisations.length === 1 ? "Organisation" : "Organisations"}
            </span>
          </button>
          <span className="acct-id__rule" aria-hidden="true" />
          <button
            type="button"
            className="acct-stat"
            onClick={() => setTab("access")}
          >
            <span className="acct-stat__n">{roleCount}</span>
            <span className="acct-stat__k">{roleCount === 1 ? "Role" : "Roles"}</span>
          </button>

          {showResume && (
            <button type="button" className="acct-cta" onClick={goResume}>
              {resume.label}
            </button>
          )}
          <button
            type="button"
            className="acct-cta acct-cta--ghost"
            onClick={() => setTab("security")}
          >
            Security
          </button>
        </div>
      </header>

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <nav className="acct-tabs" aria-label="Account sections">
        {/* The way out, again — shown only on a phone, where the strip above is
            the one piece of chrome that stays on screen. The cover's link is
            the way out at the top of the page and scrolls away with the cover;
            this takes over from it. Both say the same thing, and on a phone
            only one of them is ever the nearest. */}
        <button
          type="button"
          className="acct-tabs__back"
          aria-label={wayBack.label}
          title={wayBack.label}
          onClick={goBack}
        >
          ←
        </button>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={"acct-tab" + (tab === t.key ? " acct-tab--on" : "")}
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="acct-body">
        <div className="acct-main">
          {notices}

          {tab === "profile" && (
            <>
              <section className="acct-sec">
                <div className="acct-sec__head">
                  <h2 className="acct-sec__title">Identity</h2>
                </div>

                <div className="acct-sec__body acct-sec__body--split">
                  <form className="acct-form" onSubmit={submitName} noValidate>
                    <label className="acct-field">
                      <span className="acct-field__label">Display name</span>
                      <input className="acct-field__input" type="text" autoComplete="name"
                             value={name} onChange={(e) => { setName(e.target.value); setNameDone(""); }}
                             disabled={nameBusy} required />
                    </label>

                    <div className="acct-msg acct-msg--error" role="alert" aria-live="polite">{nameError}</div>
                    <div className="acct-msg acct-msg--ok" role="status" aria-live="polite">{nameDone}</div>

                    <button className="acct-btn" type="submit"
                            disabled={nameBusy || !name.trim() || name.trim() === user?.fullName}>
                      {nameBusy ? "Saving…" : "Save name"}
                    </button>
                  </form>

                  <dl className="acct-facts">
                    <div className="acct-fact">
                      <dt>Email</dt>
                      <dd>{email || "-"}</dd>
                    </div>
                    <div className="acct-fact">
                      <dt>Home organisation</dt>
                      <dd>{homeOrg ?? "-"}</dd>
                    </div>
                    <div className="acct-fact">
                      <dt>Account created</dt>
                      <dd>{fmtDate(profile?.createdAt)}</dd>
                    </div>
                    <div className="acct-fact">
                      <dt>Status</dt>
                      <dd>{profile?.status ? <StatusPill status={profile.status} /> : "-"}</dd>
                    </div>
                  </dl>
                </div>
              </section>

              {/* Where the reference puts "Previously collaborated with". Same
                  shape — a row of small chips with a glyph — and here it is
                  the organisations this account can actually open, which is
                  the nearest true thing and is worth seeing at a glance. */}
              <section className="acct-sec">
                <div className="acct-sec__head">
                  <h2 className="acct-sec__title">Organisations</h2>
                </div>
                <div className="acct-sec__body">
                  {access.organisations.length === 0 ? (
                    <p className="acct-placeholder">No organisations are assigned to you.</p>
                  ) : (
                    <div className="acct-chips">
                      {access.organisations.map((o) => (
                        <span className="acct-chip acct-chip--org" key={o.id}>
                          <OrgMark org={o} />
                          {o.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* The reference's "Expertise" row. Read-only, because these are
                  granted rather than claimed. */}
              <section className="acct-sec">
                <div className="acct-sec__head">
                  <h2 className="acct-sec__title">
                    What you can do here
                    {activePerms.length > 0 && (
                      <span className="acct-sec__n">{activePerms.length}</span>
                    )}
                  </h2>
                </div>
                <div className="acct-sec__body">
                  {activePerms.length === 0 ? (
                    <p className="acct-placeholder">
                      No permissions are recorded for you in this organisation.
                    </p>
                  ) : (
                    <div className="acct-chips">
                      {permsShown.map((slug) => (
                        <span className="acct-chip" key={slug} title={slug}>
                          {prettySlug(slug)}
                        </span>
                      ))}
                      {/* The overflow chip IS the control, as in the reference.
                          A separate "Show all" link below the row would be a
                          second thing to look at for a list that is already the
                          quietest on the page. */}
                      {permsHidden > 0 && (
                        <button
                          type="button"
                          className="acct-chip acct-chip--more"
                          onClick={() => setAllPerms(true)}
                        >
                          +{permsHidden}
                        </button>
                      )}
                      {allPerms && activePerms.length > PERM_PREVIEW && (
                        <button
                          type="button"
                          className="acct-chip acct-chip--more"
                          onClick={() => setAllPerms(false)}
                        >
                          Show less
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </section>

              <section className="acct-sec">
                <div className="acct-sec__head">
                  <h2 className="acct-sec__title">Preferences</h2>
                </div>

                <div className="acct-sec__body">
                  <fieldset className="acct-choice">
                    <legend className="acct-field__label">Appearance</legend>
                    <div className="acct-choice__row">
                      {[
                        /* Match system and Dark are shown and disabled rather than
                           removed. A row that silently loses two of its three options
                           reads as a bug in the page; a disabled control with a
                           reason reads as a decision, and the hint below carries the
                           reason once for all of them. */
                        { key: "system", label: "Match system", off: true },
                        { key: "dark", label: "Dark", off: true },
                        { key: "light", label: "Light" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          className={
                            "acct-choice__opt" +
                            (themePref === opt.key ? " acct-choice__opt--on" : "") +
                            (opt.off ? " acct-choice__opt--off" : "")
                          }
                          disabled={opt.off}
                          aria-pressed={themePref === opt.key}
                          title={opt.off ? "Not available, FleetTrack is light only" : undefined}
                          onClick={() => setThemePref(opt.key)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <span className="acct-field__hint">
                      FleetTrack uses the light theme everywhere. Match system and Dark
                      are not available.
                    </span>
                  </fieldset>

                  <fieldset className="acct-choice">
                    <legend className="acct-field__label">Push notification</legend>
                    <div className="acct-choice__row">
                      {[{ on: true, label: "On" }, { on: false, label: "Off" }].map((opt) => {
                        const off = push === "unsupported" || (push === "denied" && opt.on);
                        const chosen = (push === "on") === opt.on;
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            className={"acct-choice__opt" + (chosen ? " acct-choice__opt--on" : "") + (off ? " acct-choice__opt--off" : "")}
                            disabled={off || pushBusy}
                            aria-pressed={chosen}
                            onClick={() => choosePush(opt.on)}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="acct-field__hint">
                      {push === "unsupported" ? "This browser cannot receive push notifications."
                        : push === "denied" ? "Blocked for this site in the browser settings. Allow notifications there, then turn it on here."
                          : pushBusy ? "Working…"
                            : "On this device only. Repair ticket numbers arrive here as they are issued."}
                    </span>
                  </fieldset>
                </div>
              </section>
            </>
          )}

          {tab === "security" && (
            <>
              <section className="acct-sec">
                <div className="acct-sec__head">
                  <h2 className="acct-sec__title">Password</h2>
                </div>

                <div className="acct-sec__body">
                  <form className="acct-form acct-form--row" onSubmit={submitPassword} noValidate>
                    <label className="acct-field">
                      <span className="acct-field__label">Current password</span>
                      <input className="acct-field__input" type="password" autoComplete="current-password"
                             value={current} onChange={(e) => { setCurrent(e.target.value); setPwDone(""); }}
                             disabled={pwBusy} required />
                    </label>

                    <label className="acct-field">
                      <span className="acct-field__label">New password</span>
                      <span className="acct-field__pw">
                        <input className="acct-field__input" type={showPw ? "text" : "password"}
                               autoComplete="new-password" value={next}
                               onChange={(e) => { setNext(e.target.value); setPwDone(""); }}
                               disabled={pwBusy} required />
                        {/* type="button" — a bare button inside a form submits it. */}
                        <button type="button" className="acct-field__eye" onClick={() => setShowPw((v) => !v)}
                                aria-label={showPw ? "Hide password" : "Show password"}
                                aria-pressed={showPw} disabled={pwBusy}>
                          {showPw ? "Hide" : "Show"}
                        </button>
                      </span>
                      <span className="acct-field__hint">
                        At least {MIN_LENGTH} characters. A passphrase beats a puzzle.
                      </span>
                    </label>

                    <div className="acct-msg acct-msg--error" role="alert" aria-live="polite">{pwError}</div>
                    <div className="acct-msg acct-msg--ok" role="status" aria-live="polite">{pwDone}</div>

                    <button className="acct-btn" type="submit" disabled={pwBusy || !current || !next}>
                      {pwBusy ? "Changing…" : "Change password"}
                    </button>
                  </form>
                </div>
              </section>

              <section className="acct-sec acct-sec--muted">
                <div className="acct-sec__head">
                  <h2 className="acct-sec__title">Two-step verification</h2>
                </div>
                <div className="acct-sec__body">
                  {/* Stated plainly rather than shown as a dead toggle. A switch that
                      does nothing is a worse lie than a sentence saying "not yet". */}
                  <p className="acct-placeholder">
                    Not available yet. When it arrives you will set it up here, and
                    sign-in will ask for a code from your phone as well as your password.
                  </p>
                </div>
              </section>

              <section className="acct-sec">
                <div className="acct-sec__head">
                  <h2 className="acct-sec__title">Sessions</h2>
                </div>

                <div className="acct-sec__body">
                  <div className="acct-msg acct-msg--error" role="alert" aria-live="polite">{sessionNote}</div>

                  <button type="button" className="acct-btn acct-btn--danger"
                          onClick={endEverything} disabled={sessionBusy === "all"}>
                    {sessionBusy === "all" ? "Signing out…" : "Sign out of every device"}
                  </button>
                </div>
              </section>
            </>
          )}

          {tab === "access" && (
            <section className="acct-sec">
              <div className="acct-sec__head">
                <h2 className="acct-sec__title">Your access</h2>
              </div>

              <div className="acct-sec__body">
                {access.platformRoles.length > 0 && (
                  <div className="acct-platform">
                    <span className="acct-platform__label">Platform</span>
                    <span className="acct-platform__roles">
                      {access.platformRoles.map((r) => r.name).join(", ")}
                    </span>
                  </div>
                )}

                {access.organisations.length === 0 ? (
                  <p className="acct-placeholder">No organisations are assigned to you.</p>
                ) : (
                  <ul className="acct-orgs">
                    {access.organisations.map((o) => (
                      <li className="acct-org" key={o.id}>
                        <div className="acct-org__head">
                          <OrgMark org={o} />
                          <span className="acct-org__name">{o.name}</span>
                          {o.code && <span className="acct-org__code">{o.code}</span>}
                        </div>
                        <div className="acct-org__roles">
                          {o.roles.length === 0 ? (
                            <span className="acct-org__norole">No role assigned</span>
                          ) : (
                            o.roles.map((r) => (
                              <span className="acct-role" key={r.slug} title={`Assigned ${fmtDate(r.assignedAt)}`}>
                                {r.name}
                              </span>
                            ))
                          )}
                        </div>
                        <div className="acct-org__meta">
                          {o.allVehicles
                            ? "Every vehicle"
                            : `${o.vehicleScopeCount} vehicle${o.vehicleScopeCount === 1 ? "" : "s"}`}
                          {" · joined "}{fmtDate(o.joinedAt)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}
        </div>

        {/* ── Rail ───────────────────────────────────────────────────────
            Outside the tabs, and that is the whole point: this is the answer to
            "what do I hold", and it must not be a click away on any tab. */}
        <aside className="acct-rail">
          <section className="acct-card">
            <h2 className="acct-card__title">Home organisation</h2>
            <div className="acct-card__body">
              <div className="acct-linkbox">
                <span className="acct-linkbox__text">{homeOrg ?? "Not assigned"}</span>
                {profile?.organisation?.code && (
                  <span className="acct-linkbox__tag">{profile.organisation.code}</span>
                )}
              </div>
            </div>
          </section>

          {/* The reference's Community Karma card: a stack of tinted rows, one
              number each. Same rows, real numbers. */}
          <section className="acct-card">
            <h2 className="acct-card__title">At a glance</h2>
            <div className="acct-card__body acct-card__body--flush">
              <div className="acct-stat-row acct-stat-row--blue">
                <span className="acct-stat-row__n">{access.organisations.length}</span>
                <span className="acct-stat-row__k">Organisations</span>
              </div>
              <div className="acct-stat-row acct-stat-row--green">
                <span className="acct-stat-row__n">{roleCount}</span>
                <span className="acct-stat-row__k">Roles held</span>
              </div>
              <div className="acct-stat-row acct-stat-row--amber">
                <span className="acct-stat-row__n">{activePerms.length}</span>
                <span className="acct-stat-row__k">Permissions here</span>
              </div>
              <div className="acct-stat-row acct-stat-row--violet">
                <span className="acct-stat-row__n">{profile?.passwordChangeCount ?? 0}</span>
                <span className="acct-stat-row__k">Password changes</span>
              </div>
            </div>
          </section>

          {/* The reference's Badges card. Roles are the nearest true thing: a
              small set of named things granted to you by somebody else. */}
          <section className="acct-card">
            <h2 className="acct-card__title">Roles</h2>
            <div className="acct-card__body">
              {uniqueRoles.length === 0 ? (
                <p className="acct-placeholder">No roles assigned.</p>
              ) : (
                <div className="acct-chips">
                  {uniqueRoles.map((r) => (
                    <span
                      key={r.key}
                      className={"acct-chip" + (r.platform ? " acct-chip--platform" : "")}
                      title={r.platform
                        ? "Applies in every organisation"
                        : r.orgs.join(", ")}
                    >
                      {r.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
