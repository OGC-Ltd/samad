/**
 * User accounts for one organisation.
 *
 * ## The thing that shapes this page
 *
 * A person is not "a user with a role". They are a user with a role *per
 * organisation* — a dispatcher at one site and an accountant at another — and
 * the first version of this form could not say that. It had one role dropdown
 * and one implicit organisation, so anybody who worked across two sites was
 * either wrong in the roster or entered twice.
 *
 * So the form's centre of gravity is the ORGANISATION LIST: pick the
 * organisations, and each one gets its own roles beneath it. One org with one
 * role is the common case and still costs two clicks; the harder case is
 * possible at all, which it was not before.
 *
 * Only organisations the ADMIN can reach are offered, because those are the
 * only ones the server will accept — it re-checks every one of them, so a
 * picker showing more would just be a way to earn a 403.
 *
 * The roles under each are whatever the server's roles table holds for that
 * organisation, catalogue roles first. The list is not filtered in the client
 * and not filtered against a constant on the server: a role an operator added
 * by hand is a real role, and a picker that silently omitted it would have
 * nothing on screen to explain the absence.
 *
 * ## Invitations, not passwords
 *
 * There is no password field and there will not be one. The person sets their
 * own through an emailed link, which also closes a real hole: provisioning
 * used to overwrite the password of any account matching the email, so typing
 * a colleague's address at another tenant handed you their account.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCompanies } from "../../context/AppContext";
import { useAuth } from "../../context/AuthContext";
import { usePermissions } from "../../hooks/usePermissions";
import { useApiData } from "../../hooks/useApiData";
import {
  listUsersAcrossOrgs, listAssignableRoles, createOrgUser, updateOrgUser, resendInvite, setUserStatus,
  listUserMemberships, setUserMembership, setUserRole, removeUserMembership,
  deleteOrgUserPermanently,
} from "../../api/users";
import { firstMessage, isMissingEndpoint } from "../../lib/formErrors";
import {
  sortRows, nextSort, paginate,
  selectionState, toggleSelected, toggleAllVisible, pruneSelection,
} from "../../lib/rosterView";
import TablePager, { PAGE_STEP } from "./TablePager";
import { toCsv, exportFilename, downloadCsv } from "../../lib/rosterExport";
import { accountState } from "../../lib/accountState";
import { companyMark } from "../../lib/companyLogos";
import { maskEmail, maskPhone } from "../../lib/mask";
import { displayGroupText } from "../../lib/groupDisplay";
import {
  confirmPhraseFor, confirmMatches, confirmState, skipsTypedConfirmation,
} from "../../lib/deleteConfirmation";
import LoadError from "../shared/LoadError";
import TabEmptyState from "../shared/TabEmptyState";
import { DriversIcon } from "../footer/NavIcons";
import "./UserAdminPanel.scss";

const EMPTY_FORM = { fullName: "", email: "", phone: "", employeeId: "" };

/**
 * The columns, as data.
 *
 * A list rather than hard-coded `<th>`s because three separate things now read
 * it: the head, the cells, and the export. Keeping them in step by hand is how
 * a CSV comes to have six headers over five columns of values.
 *
 * `always` marks the column the Columns menu may not hide. A roster with the
 * name column switched off is a table of facts about nobody.
 */
/**
 * The notice for a set-password link the server handed back instead of
 * mailing it. The link is also put on the clipboard, best effort: the notice
 * stays up (warn toasts have no clock) so it can be selected by hand too.
 */
function shareLinkNotice(lead, invite) {
  navigator.clipboard?.writeText(invite.link).catch(() => {});
  const until = invite.expiresAt ? ` It works once, until ${new Date(invite.expiresAt).toLocaleString()}.` : "";
  return `${lead} No email is sent from this server: give them this link to set their password (copied):  ${invite.link}${until}`;
}

const COLUMNS = [
  { key: "name",     label: "Full name",  always: true },
  /* Email and phone are COLUMNS now, not a second line under the name. They
     were stacked there because the roster had one identity column and the
     address had nowhere else to go — which made the name cell two facts deep
     while every other cell was one, and made the address unsortable,
     unhideable and impossible to read down. */
  { key: "email",    label: "Email" },
  { key: "phone",    label: "Phone" },
  { key: "org",      label: "Organisation" },
  /* Which group administers this person. On the roster because the roster is
     NARROWED by it once USER_GROUP_ENFORCE is on: without the axis on screen,
     a short list and a broken one look the same. */
  { key: "group",    label: "Group" },
  /* "Roles here" — the "here" was answering a question the Organisation
     column beside it already answers. */
  { key: "roles",    label: "Roles" },
  { key: "status",   label: "Status" },
  { key: "created",  label: "Created" },
  { key: "password", label: "Password" },
];

const VIEWS = [
  { key: "table", label: "Table" },
  { key: "board", label: "Board" },
  { key: "list",  label: "List" },
];

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal panel that arrives from the right, over the page.
 *
 * The live map's vehicle panel by another name, deliberately: that is the one
 * shape this product already uses for "the detail of a single thing, with the
 * list it came from still behind it", and a second shape for the same idea is
 * a second thing to learn. The difference is that the map's panel is a COLUMN
 * of the shell — it takes width from the map — while this one floats on a
 * scrim, because a roster of 380 people has no width to give away.
 *
 * ## Why it is a component and not two copies
 *
 * Two panels on this page open this way, Add user and Edit. Everything below
 * is the part that is easy to get wrong once and impossible to keep right
 * twice: the unmount timer that lets the slide-out finish, the focus that has
 * to land inside and then go back where it came from, the Tab that must not
 * reach the roster under the scrim, and the Escape that must not ALSO leave
 * the page.
 */
function Drawer({ open, onClose, id, title, hint, children }) {
  /* Mounted-but-leaving. The panel has to stay in the DOM for the length of
     its slide out, and it must NOT be in the tab order while it does. */
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef(null);
  const openerRef = useRef(null);

  useEffect(() => {
    if (open) { setMounted(true); return undefined; }
    if (!mounted) return undefined;
    const t = setTimeout(() => setMounted(false), 200);   // matches ua-drawer-out
    return () => clearTimeout(t);
  }, [open, mounted]);

  /* Focus lands on the first control and goes back to whatever opened the
     panel. Without the second half, dismissing it drops a keyboard user at the
     top of the document and they tab through the whole toolbar to get back. */
  useEffect(() => {
    if (!open || !mounted) return undefined;
    openerRef.current = document.activeElement;
    const first = panelRef.current?.querySelector(FOCUSABLE);
    if (first) first.focus();
    return () => {
      const back = openerRef.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, mounted]);

  /**
   * Escape closes this, and Tab stays inside it.
   *
   * CAPTURE phase and `preventDefault`, both deliberately: UserAdminScreen
   * listens for Escape on the same document to leave the whole page, and it
   * registered first. Without this, dismissing a panel would throw the user
   * out of the roster entirely — the screen's handler reads defaultPrevented
   * and stands down.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const stops = root.querySelectorAll(FOCUSABLE);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      // A modal covers the page behind it. Tabbing to something under the
      // scrim would move focus somewhere the pointer cannot reach.
      if (!root.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    /* Portalled to the body on purpose. A `position: fixed` panel is
       re-anchored by any ancestor carrying a transform, filter or containment
       — and this page's arrival animation puts a transform on exactly those
       ancestors. Rendered in place it would work until the first render and
       then start hanging off a scrolled container. */
    <div className={"ua-drawer-layer" + (open ? "" : " ua-drawer-layer--out")}>
      {/* The scrim closes it, which is the gesture people try first. It is
          also what makes this a modal rather than a sidebar: the roster stays
          legible behind it, and stays out of reach. */}
      <div className="ua-drawer__scrim" onClick={onClose} aria-hidden="true" />

      <aside
        className="ua-drawer"
        id={id}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <header className="ua-drawer__head">
          <span className="ua-drawer__heading">
            <h2 className="ua-drawer__title" id={`${id}-title`}>{title}</h2>
            {hint && <span className="ua-drawer__hint">{hint}</span>}
          </span>
          <button type="button" className="ua-drawer__close" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                 stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {children}
      </aside>
    </div>,
    document.body,
  );
}

/**
 * The organisation picker, shared by both panels.
 *
 * Organisations only, since 2026-10-27. A person holds ONE role across all of
 * their organisations (operator: "roles are organisation independent"), chosen
 * once in RolePicker above this list; it used to be chosen here per
 * organisation, which let one person be an Operator in one place and a
 * Manager in the next, and hid a platform role altogether.
 *
 * ## What it is sized for
 *
 * An administrator at a tenant with twenty organisations. The first version
 * listed all of them, every one expanded to its full role list the moment it
 * was ticked, which for twenty sites is roughly nine hundred pixels of picker
 * in a panel four hundred and sixty wide — and every one of those rows was a
 * site this person does not belong to, in front of the two that they do.
 *
 * So the list is split on the only distinction that matters here. The
 * organisations somebody HOLDS are the answer to "what do they have", which is
 * why the panel was opened; everything else answers "add them somewhere",
 * which is a different job, done less often, and now folded behind one
 * control. The section is then as long as their access is, not as long as the
 * tenant is — four sites or forty.
 *
 */
function OrgPicker({
  orgs, draft, base, disabled, currentOrgId, onToggleOrg, onSelectAll,
}) {
  const [adding, setAdding] = useState(false);
  const [find, setFind] = useState("");

  /* An organisation being REMOVED stays in the held list until the save. It
     is still part of what you are deciding — dropping it back into the
     eighteen would make un-doing a mistaken untick a search. */
  const held = orgs.filter((o) => o.id in draft || (base != null && o.id in base));
  const rest = orgs.filter((o) => !held.includes(o));
  const selectedCount = orgs.filter((o) => o.id in draft).length;
  const allSelected = selectedCount === orgs.length;
  const needle = find.trim().toLowerCase();
  const shown = needle ? rest.filter((o) => o.name.toLowerCase().includes(needle)) : rest;

  if (orgs.length === 0) {
    return <p className="ua-access__empty">No organisations are available to you.</p>;
  }

  return (
    <>
      {base == null && orgs.length > 1 && (
        <button type="button" className="ua-org__select-all" role="checkbox"
                aria-checked={allSelected ? true : selectedCount > 0 ? "mixed" : false}
                onClick={() => onSelectAll(!allSelected)}
                disabled={disabled}>
          <span className="ua-box" aria-hidden="true" />
          <span>Select all organisations</span>
          <span className="ua-org__select-count">{selectedCount} of {orgs.length}</span>
        </button>
      )}
      {held.length === 0 ? (
        <p className="ua-access__empty">
          No organisation chosen yet. Somebody with no organisation has no way in.
        </p>
      ) : (
        <ul className="ua-orgs">
          {held.map((org) => {
            const on = org.id in draft;
            const wasIn = base != null && org.id in base;
            return (
              <li className={"ua-org" + (on ? " ua-org--on" : "")} key={org.id}>
                <button type="button" className="ua-org__toggle"
                        role="checkbox" aria-checked={on}
                        onClick={() => onToggleOrg(org.id)} disabled={disabled}>
                  <span className="ua-box" aria-hidden="true" />
                  <OrgMark org={org} className="ua-org__mark" />
                  <span className="ua-org__name">{org.name}</span>
                  {org.id === currentOrgId && base == null && (
                    <span className="ua-org__here">current</span>
                  )}
                  {wasIn && !on && <span className="ua-org__going">removing</span>}
                  {!wasIn && on && base != null && <span className="ua-org__here">adding</span>}
                </button>

              </li>
            );
          })}
        </ul>
      )}

      {rest.length > 0 && (adding ? (
        <div className="ua-orgadd">
          {/* Only past the point where a list stops being readable at a glance.
              A search box over five organisations is furniture. */}
          {rest.length > 8 && (
            <label className="ua-field">
              <span className="ua-label">Find an organisation</span>
              <input className="ua-input" type="search" value={find}
                     placeholder={`${rest.length} not yet granted`}
                     onChange={(e) => setFind(e.target.value)} disabled={disabled} />
            </label>
          )}

          {shown.length === 0 ? (
            <p className="ua-roles__empty">Nothing matches {find.trim()}.</p>
          ) : (
            <ul className="ua-orgs ua-orgs--pick">
              {shown.map((org) => (
                <li className="ua-org" key={org.id}>
                  <button type="button" className="ua-org__toggle"
                          role="checkbox" aria-checked={false}
                          onClick={() => {
                            onToggleOrg(org.id);
                            setAdding(false); setFind("");
                          }}
                          disabled={disabled}>
                    <span className="ua-box" aria-hidden="true" />
                    <OrgMark org={org} className="ua-org__mark" />
                    <span className="ua-org__name">{org.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" className="ua-action"
                  onClick={() => { setAdding(false); setFind(""); }}>
            Done
          </button>
        </div>
      ) : (
        <button type="button" className="ua-tbtn ua-orgadd__open"
                onClick={() => setAdding(true)} disabled={disabled}>
          Add to another organisation
          {rest.length > 1 && <span className="ua-orgadd__n">{rest.length}</span>}
        </button>
      ))}
    </>
  );
}

/**
 * The person's role: one, for every organisation they belong to.
 *
 * Picking a role replaces the one held, because a person has a role rather
 * than a collection of them. Somebody who already holds several shows them
 * all lit until one is picked. A platform role (offered only to a platform
 * administrator) says in words that it reaches every organisation; a role
 * they hold that this list does not offer is still drawn, so it can be seen
 * and replaced rather than surviving unnoticed.
 */
function RolePicker({ roles, chosen, held = [], onChoose, disabled }) {
  if (roles === undefined) return <span className="ua-roles__empty">Loading roles…</span>;
  const listed = new Set(roles.map((r) => r.slug));
  const all = [...roles, ...held.filter((r) => chosen.includes(r.slug) && !listed.has(r.slug))];
  if (all.length === 0) return <span className="ua-roles__empty">No roles available here yet.</span>;
  return (
    <div className="ua-roles ua-roles--person" role="radiogroup" aria-label="Role">
      {all.map((r) => {
        const on = chosen.includes(r.slug);
        return (
          <button key={r.slug} type="button" role="radio" aria-checked={on}
                  className={"ua-role" + (on ? " ua-role--on" : "") + (r.platform ? " ua-role--platform" : "")}
                  onClick={() => onChoose(r.slug)}
                  disabled={disabled}
                  title={r.platform ? "This role reaches every organisation." : undefined}>
            {r.name}
            {r.platform && <span className="ua-role__scope">all orgs</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The view switcher's glyphs. Drawn, not imported — this app ships no icon
 *  set, and the file already draws its own magnifier and select caret. */
function ViewIcon({ kind }) {
  const common = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none",
                   stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true };
  if (kind === "board") {
    return (
      <svg {...common}>
        <rect x="1.5" y="2.5" width="4" height="11" rx="1" />
        <rect x="6.75" y="2.5" width="4" height="7.5" rx="1" />
        <rect x="12" y="2.5" width="2.5" height="9.5" rx="1" />
      </svg>
    );
  }
  if (kind === "list") {
    return (
      <svg {...common} strokeLinecap="round">
        <path d="M2 4h12M2 8h12M2 12h12" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 6.5h13M6 6.5v7" />
    </svg>
  );
}

/** Initials on a hue derived from the name. See hueOf for why it is the name. */
/**
 * One contact detail, masked or not, and switchable either way.
 *
 * ## Two shapes, because the two states want different things
 *
 * MASKED, the value is the button: the thing you read and the thing you click
 * are one object, and the column carries one control rather than a control
 * beside a caption.
 *
 * REVEALED, the value has to go back to being a real mailto/tel link — that
 * is the point of revealing it — and a link cannot also be the undo, because
 * clicking it opens a mail client. So the undo is its own small control
 * beside it, and it is drawn as the mask itself: clicking the dots puts the
 * dots back. A person who has just seen what the dots mean does not need a
 * second vocabulary for hiding.
 *
 * Email and phone switch INDEPENDENTLY. They are asked for by different jobs
 * — you are writing to somebody, or you are ringing them — and unmasking a
 * number to send an email is a reveal nobody asked for.
 *
 * The mask is dots, which a screen reader either skips or reads as
 * punctuation, so the accessible name carries the whole meaning in both
 * states.
 */
function Contact({ value, kind, shown, onToggle, who }) {
  if (!value) return <span className="ua-row__none">{"-"}</span>;

  if (shown) {
    return (
      <span className="ua-contact">
        <a className="ua-row__mail" href={`${kind === "email" ? "mailto" : "tel"}:${value}`}>
          {value}
        </a>
        <button type="button" className="ua-contact__hide" onClick={onToggle}
                aria-label={`Hide ${kind} for ${who}`}
                title={`Hide this ${kind} again`}>
          <svg width="12" height="4" viewBox="0 0 12 4" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="2" r="1.35" />
            <circle cx="6" cy="2" r="1.35" />
            <circle cx="10" cy="2" r="1.35" />
          </svg>
        </button>
      </span>
    );
  }

  return (
    <button type="button" className="ua-row__masked" onClick={onToggle}
            aria-label={`Show ${kind} for ${who}`}
            title={`Show this ${kind}`}>
      {kind === "email" ? maskEmail(value) : maskPhone(value)}
    </button>
  );
}

/**
 * The toast's mark, one per kind of operation.
 *
 * Colour alone would fail two readers and one printer, and it would also fail
 * a third case peculiar to this page: suspended and deleted are BOTH bad news
 * about an account and neither is a failure, so amber-versus-red on its own
 * is a distinction nobody can be expected to hold. The glyph says which:
 * a pause, a cross, a tick, a plus, an exclamation.
 */
function ToastMark({ tone }) {
  const paths = {
    created:   <><path d="M8 4.4v7.2" /><path d="M4.4 8h7.2" /></>,
    ok:        <path d="M4.6 8.3l2.4 2.4 4.4-5" />,
    suspended: <><path d="M6.4 5.4v5.2" /><path d="M9.6 5.4v5.2" /></>,
    deleted:   <><path d="M5.5 5.5l5 5" /><path d="M10.5 5.5l-5 5" /></>,
    warn:      <><path d="M8 4.8v3.9" /><path d="M8 11.2h.01" /></>,
  };
  return (
    <span className="ua-toast__mark" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        {/* The ring is common to all of them, so the marks read as one family
            of badges rather than as five unrelated icons. */}
        <circle cx="8" cy="8" r="6.6" />
        {paths[tone] ?? paths.warn}
      </svg>
    </span>
  );
}

/**
 * One organisation's mark, wherever an organisation is named.
 *
 * Split out of OrgBadge because the access panel lists the same tenants down
 * the side of a drawer, and a list of names there has exactly the problem the
 * table cell had: "MENENGAI SUGAR", "Mufindi Paper", "Ndhiwa Sukari" and
 * "West Kenya Sugar Ltd" are four bolded strings a tick apart from each
 * other, and the one being looked for is found by reading all of them. A mark
 * is recognised instead of read, which is the whole job of that column of
 * checkboxes.
 *
 * The letter fallback stays for tenants with no artwork on file: marks for
 * some organisations and a gap for the rest would leave the list exactly as
 * hard to scan for the rows that are hardest to tell apart.
 */
function OrgMark({ org, className = "" }) {
  const name = org?.name ?? "-";
  const mark = org ? companyMark(org) : null;
  if (mark) {
    return <img className={"ua-orgbadge__mark " + className} src={mark} alt="" />;
  }
  return (
    <span className={"ua-orgbadge__mark ua-orgbadge__mark--letter " + className}
          style={{ "--ua-avatar-h": hueOf(name) }} aria-hidden="true">
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/**
 * An organisation, with its own mark.
 *
 * Only the all-organisations view draws these, and that is the view they are
 * for: a list of company NAMES in a column is four words that all start the
 * same way ("MENENGAI SUGAR", "Mufindi Paper", "Ndhiwa Sukari"), read at
 * 12px, against a name and a status the eye is already doing work on. A mark
 * is recognised rather than read, which is the whole job of that cell.
 *
 * The mark itself is OrgMark, which the access panel draws too.
 *
 * The name stays. A mark alone would be a logo quiz, and two of these tenants
 * are sugar mills with a cane leaf in the artwork.
 */
function OrgBadge({ org, id, here }) {
  const name = org?.name ?? id ?? "-";
  return (
    /* The title is not decoration here: under 640px the list view hides the
       name and leaves the mark, and this is what a pointer gets back. The
       name itself stays in the DOM for a screen reader either way. */
    <span className={"ua-orgbadge" + (here ? " ua-orgbadge--here" : "")} title={name}>
      <OrgMark org={org} />
      <span className="ua-orgbadge__name">{name}</span>
    </span>
  );
}

function Avatar({ name, email }) {
  return (
    <span className="ua-avatar" aria-hidden="true"
          style={{ "--ua-avatar-h": hueOf(name || email) }}>
      {initialsOf(name, email)}
    </span>
  );
}

/**
 * Status as a badge: a coloured dot inside a tinted, bordered pill.
 *
 * The dot is kept INSIDE the badge rather than replaced by it. A filled
 * lozenge alone carries its meaning in its fill, which is the thing a
 * red-green reader cannot use and a 10% tint barely gives anybody; the dot is
 * the part that survives being glanced at down a column of forty rows. The
 * badge is what gives each state an edge, so "Suspended" and "Pending" read as
 * two different things at arm's length rather than as two words.
 *
 * Text sits on the tint, never on the hue itself — hence the --ink tokens.
 */
function StatusBadge({ state }) {
  return (
    <span className={`ua-badge ua-badge--${state.key}`}>
      <span className="ua-state__dot" aria-hidden="true" />
      {state.label}
    </span>
  );
}

/** Up to two initials, falling back to the email, then to a dot. */
function initialsOf(name, email) {
  const source = String(name ?? "").trim() || String(email ?? "").trim();
  if (!source) return "\u00b7";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * A stable hue for one person, 0-359.
 *
 * Derived from the name rather than from the row index, so the disc keeps its
 * colour when the table is re-sorted, paged or filtered. An avatar that
 * changed colour on every sort would be noise wearing the costume of
 * information. Saturation and lightness are fixed in CSS, so whatever hue
 * lands here still clears contrast on white.
 */
function hueOf(text) {
  const source = String(text ?? "");
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) % 360;
  return h;
}

/**
 * The status filters, and why they are these five.
 *
 * They are `accountState`'s own keys, not `status` — because ACTIVE covers two
 * opposite situations and the whole reason that helper exists is to tell them
 * apart. "No live invite" is the pair `expired` + `replaced` under one word an
 * administrator can act on: nobody is coming, and nobody will be told.
 */
/* `noun` is the chip's label as it reads inside a sentence, and it is a
   separate string because the label is not one: lowercasing "No live invite"
   into the empty-state line produced "No no live invite account matching kip". */
const STATUS_TABS = [
  { key: "all",       label: "All",            noun: "account" },
  { key: "active",    label: "Active",         noun: "active account" },
  { key: "pending",   label: "Pending",        noun: "pending account" },
  { key: "expired",   label: "No live invite", noun: "account with a lapsed invitation" },
  { key: "suspended", label: "Suspended",      noun: "suspended account" },
];

/**
 * The role names this person holds IN the organisation being administered,
 * each one said once.
 *
 * `userRoles` is a grant table, not a set of roles: the same role can be
 * granted twice over — once when the account was provisioned and once when an
 * admin re-saved the membership, or by two different admins — and every one of
 * those rows comes back. Rendered straight, that is a row reading
 * "System Administrator · System Administrator", which looks like the person
 * holds something twice when there is no such thing as holding a role twice.
 *
 * Deduplicated on the NAME rather than the role id, because two role records
 * in one organisation that print the same word are indistinguishable to
 * somebody reading the column, and that is who this list is for. Order is the
 * server's, first grant wins.
 */
function rolesIn(user, orgId) {
  const seen = new Set();
  const names = [];
  for (const ur of user.userRoles ?? []) {
    if (ur.role?.organisationId !== orgId) continue;
    const name = ur.role.name;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Every role a row's person holds, across every organisation the row covers.
 *
 * A row is one person now, not one membership, so "Roles" is the union: a
 * dispatcher at Menengai who is also an auditor at Naitiri reads as both,
 * because both are true of the person the row is about. Deduplicated on the
 * name for the same reason `rolesIn` is — two organisations that each have a
 * role called "Operator" are one word to the person reading the column.
 *
 * `scopeOrgIds` is absent on rows that never went through the cross-org read
 * (an optimistic local update, a test fixture), hence the fallback.
 */
function rolesFor(user) {
  const orgIds = user.scopeOrgIds ?? (user.scopeOrgId ? [user.scopeOrgId] : []);
  const seen = new Set();
  const names = [];
  for (const orgId of orgIds) {
    for (const name of rolesIn(user, orgId)) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Four fields, not one.
 *
 * Searching the name alone is the obvious build and the wrong one: an admin
 * chasing a stalled invitation has the EMAIL in front of them, and one chasing
 * a payroll query has the employee ID. Phone is in for the same reason. All of
 * them are optional on the server, hence the guard.
 */
function matchesQuery(user, needle) {
  if (!needle) return true;
  return [user.fullName, user.email, user.phone, user.employeeId]
    .some((v) => v && String(v).toLowerCase().includes(needle));
}

/** The role filter's sentinel for "holds nothing here" — a real thing to look
 *  for, and the roster already flags it in amber. Two colons because a <select>
 *  value is a plain string and a role could otherwise be named the sentinel;
 *  roles come from the server's roles table, where names are human ("Dispatcher",
 *  "Finance Manager") and cannot start with punctuation. */
const NO_ROLE = "::none";

/** The "every organisation I administer" choice. Same sentinel discipline as
 *  NO_ROLE above: a real organisation id is a cuid and cannot collide. */
const ALL_ORGS = "::all";

/**
 * A row's identity, which is the PAIR and not the person.
 *
 * Once the roster can show more than one organisation, the same account
 * appears once per organisation it belongs to — deliberately, because
 * "Dispatcher at Menengai" and "Operator at Sukari" are different rows with
 * different chips and different buttons. So `u.id` is no longer unique in
 * `shown`, and every place that used it to mean "this row" — the React key,
 * the open editor, the delete confirmation — has to use this instead. Keying
 * on the id alone would open both organisations' editors from one click.
 */
const rowKey = (u) => `${u.scopeOrgId}:${u.id}`;


function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function UserAdminPanel() {
  const { activeCompany } = useCompanies();
  const { orgs, user: me } = useAuth();
  const { orgId, can, canIn, isPlatform } = usePermissions();

  /**
   * Which organisation's people the roster is showing.
   *
   * ## Why this is not just the active company
   *
   * Permission to administer people is held PER ORGANISATION and is checked
   * against the organisation in the request path, never against the caller's
   * own — middleware/authorize.ts is explicit that "their home org says
   * nothing about the request in front of us". So somebody granted System
   * Administrator in two companies has always been entitled to edit and delete
   * in both, from one session, without touching the header switcher.
   *
   * The dashboard simply never asked. The roster was `listOrgUsers(orgId)`
   * with `orgId` resolved from the active company, so the only way to reach
   * another organisation's people was to become that company first — and
   * switching companies re-points the map, the fleet filters and every other
   * screen, to administer one account.
   *
   * `scope` is either an organisation id or ALL_ORGS. It starts on the active
   * company, because that is where you are and it should not surprise you.
   */
  const [scope, setScope] = useState(orgId ?? null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rowBusy, setRowBusy] = useState(null);

  /**
   * Which organisations are selected, and the roles chosen in each.
   * `{ [orgId]: string[] }` — presence of the key IS the selection, so an
   * organisation with no roles yet is still a valid grant (access, no role).
   */
  const [picked, setPicked] = useState({});
  /** The new person's role, the same in every organisation ticked. */
  const [createRoles, setCreateRoles] = useState([]);
  const [rolesByOrg, setRolesByOrg] = useState({});
  /**
   * The row being edited, and its access.
   *
   * `base` is what the server said when the editor opened; `draft` is what the
   * administrator has changed it to. Both are kept because the save is a DIFF
   * — an organisation that was ticked and still is with the same roles is not
   * written at all, so opening a row and closing it touches nothing.
   */
  const [editing, setEditing] = useState(null);
  const [editBase, setEditBase] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  /* Their role, for every organisation and the platform: what the server said
     on open (`editRolesBase`, slug + name + platform), and what it is now. */
  const [editRolesBase, setEditRolesBase] = useState(null);
  const [editRoles, setEditRoles] = useState([]);
  const [editBusy, setEditBusy] = useState(false);
  /* A SNAPSHOT of the person, not a lookup back into the roster. The panel
     outlives its row — saving refreshes the list, and the object that row was
     drawn from is replaced — so holding the key alone would leave the open
     panel describing somebody who no longer exists at that index. */
  const [editUser, setEditUser] = useState(null);
  /* Their own details, which the panel can now change. `editIdentity` is the
     same diff discipline as `editBase` above: what the server said when the
     panel opened, so an untouched field is not written back. */
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [editIdentity, setEditIdentity] = useState(EMPTY_FORM);

  /* Whether the account is suspended, AS A DRAFT.
     It used to apply on the click, on the argument that ending live sessions
     is not something to leave sitting in a draft. That argument loses to a
     simpler one: this panel has a Save button and a Cancel button, so every
     control in it has to mean the same thing by being clicked. A panel where
     two fields wait and one fires is a panel where Cancel is a lie. */
  const [editStatus, setEditStatus] = useState(null);

  /**
   * The row whose permanent delete is being confirmed, and what has been typed
   * into it.
   *
   * A row rather than a dialog, for the reason the access editor gives above:
   * nothing in this app implements a focus trap, so a modal here would be a
   * worse version of the same thing. It sits under the person it is about, and
   * only one can be open at a time — `deleting` is an id, not a set.
   */
  const [deleting, setDeleting] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  /**
   * Finding one person, and the state that does it.
   *
   * All of it is CLIENT-side, which is a decision rather than a shortcut:
   * `listOrgUsers` fetches the organisation's system accounts in one page of
   * 100 and they are all in memory already. A server round-trip per keystroke
   * would be slower, would need debouncing, and would spend a request to
   * re-learn something this component is holding.
   *
   * It stops being the right call the day an organisation passes that page —
   * at which point the fix is paging the request, not filtering harder here.
   */
  const [query, setQuery] = useState("");
  const [statusKey, setStatusKey] = useState("all");
  const [roleName, setRoleName] = useState("any");
  const searchRef = useRef(null);

  /**
   * The invite form is closed until asked for.
   *
   * It used to be the first thing on the page, above the roster, expanded on
   * every visit — five fields and an organisation picker between you and the
   * thing you came to read. Inviting is occasional; reading the roster is why
   * this screen is open. So the roster leads, and asking for the form opens a
   * panel over it from the right — the shape the live map already uses for a
   * vehicle, so the one gesture on this product for "here is the detail of a
   * thing, the page behind it is still there" is the same gesture twice.
   *
   * It was a band that pushed the roster down the page. That band could not be
   * both wide enough for an organisation picker and short enough to leave the
   * roster visible, so on a laptop it shipped the roster off the bottom of the
   * screen — the form hid the very list it was being filled in from.
   */
  const [inviteOpen, setInviteOpen] = useState(false);

  const openInvite = useCallback(() => {
    setError("");
    setCreateRoles([]);
    setInviteOpen(true);
  }, []);
  const closeInvite = useCallback(() => setInviteOpen(false), []);

  /* ── How the roster is being LOOKED at ──────────────────────────────────
     Separate from what it contains. Everything above this point decides which
     people are on the list; everything here decides the shape they are drawn
     in, and none of it touches the data or the server. */
  const [view, setView] = useState("table");
  const [sort, setSort] = useState(null);
  const [page, setPage] = useState(1);
  // Fifteen, like every table (TablePager); no per-table page size any more.
  const perPage = PAGE_STEP;
  const [selected, setSelected] = useState(() => new Set());

  /**
   * Masking is a switch, and it starts on.
   *
   * Two controls, because there are two different jobs. `masked` is the
   * column-wide one in the toolbar: an admin who has the room to themselves
   * turns it off once and works with real addresses all session, then turns
   * it back on before the screen is shared. `revealed` is the per-person
   * shortcut for the commoner case — you want ONE number, and unmasking
   * thirty-nine others to get it is not a privacy control.
   *
   * Turning the switch back on clears the per-person reveals, because
   * otherwise "masked" would be a state in which things are visible.
   *
   * Neither is persisted. A reveal lasts as long as the reason for it, and a
   * masking preference that survived a reload would come back off on somebody
   * else's screen. `revealed` is keyed by USER id, not by row key: the same
   * person appears once per organisation in the all-orgs view, and their
   * phone number is not a different fact in the second row.
   */
  const [masked, setMasked] = useState(true);

  /* EXCEPTIONS to the switch, not a list of revealed things. Holding it this
     way is what lets one control work in both directions: against a masked
     column the flipped cells are the ones showing, against an unmasked one
     they are the ones hiding, and the button in the cell is the same button
     either way. Keyed `userId:kind`, because email and phone are asked for by
     different jobs and revealing one is not consent to the other. */
  const [flipped, setFlipped] = useState(() => new Set());

  const toggleContact = useCallback((id, kind) => {
    setFlipped((prev) => {
      const next = new Set(prev);
      const key = `${id}:${kind}`;
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  /* The switch clears the exceptions, because an exception to a rule that has
     just been reversed is not an exception to anything — keeping them would
     mean pressing "Hide contacts" and watching two addresses stay up. */
  const toggleMasking = useCallback(() => {
    setFlipped(new Set());
    setMasked((on) => !on);
  }, []);

  /**
   * Is this one field, for this one person, on screen in the clear?
   *
   * "Flipped equals masked" reads as a trick and is not one: against a MASKED
   * column a flipped cell is a revealed one (true === true), and against an
   * unmasked column an unflipped cell is still showing (false === false).
   * One expression, both directions.
   */
  const inClear = useCallback(
    (id, kind) => flipped.has(`${id}:${kind}`) === masked,
    [masked, flipped],
  );
  const [hiddenCols, setHiddenCols] = useState(() => new Set());
  const [openMenu, setOpenMenu] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  /* An undo offer, not a notification. It exists because the bulk actions
     below are the only things on this page that change several accounts at
     once without a typed confirmation — so the safety net is on the far side
     of the action rather than in front of it. */
  const [toast, setToast] = useState(null);

  /**
   * An account changed — say so, once, near where it happened.
   *
   * The division this draws, and the reason the message strip is not simply
   * gone: a TOAST reports an event, and the page's message region reports a
   * STATE. "Suspended and signed out" is an event — it is finished, it is
   * already visible in the row behind the toast, and it should leave by
   * itself. "Created, but this server cannot send invitations" is a state:
   * somebody still cannot sign in, and a sentence that deletes itself after
   * nine seconds is the wrong way to carry a thing that is still wrong.
   *
   * Errors stay on the page for the same reason. A message you have to act on
   * must not be on a timer.
   */
  /**
   * `tone` is the OPERATION, not the mood.
   *
   * "created", "ok", "suspended", "deleted" are all successes and they do not
   * mean the same thing to somebody glancing at the corner: an account that
   * now exists, one put back, one shut out, one destroyed. Colouring them all
   * green would be reporting four different events in one voice.
   *
   * Everything in this group is still an OUTCOME, so all of it is on the
   * clock. Only `fail` and `flag` below stay up.
   */
  const say = useCallback((text, undo = null, tone = "ok") => {
    setError("");
    setToast({ text, undo, tone });
  }, []);

  /**
   * Something went wrong, or something is still wrong.
   *
   * Same object as `say`, different tone, and the tone decides ONE thing that
   * matters: whether it is on a clock. An outcome may expire because it is
   * finished and the roster behind it already shows the result. A failure may
   * not — "could not be changed" that deletes itself after nine seconds is a
   * page hiding its own bad news, and the reader is left with a roster that
   * simply looks wrong.
   *
   * `fail` also keeps the message in `error`, because both drawers show it
   * against their own submit button through aria-describedby. A form error
   * belongs beside the form as well as in the corner.
   */
  const fail = useCallback((text) => {
    setError(text);
    setToast({ text, undo: null, tone: "error" });
  }, []);

  /** Done, but not well: the account exists and nobody can sign in to it.
   *  Not an error — nothing failed to be written — and not an outcome to
   *  celebrate either, so it gets the middle tone and the same no-clock rule. */
  const flag = useCallback((text) => {
    setError("");
    setToast({ text, undo: null, tone: "warn" });
  }, []);

  const canAssignRoles = can("user:assign_role");
  /* NOTE: the typed-confirmation shortcut and the per-row action gates used
     to be computed here, once, from the ACTIVE company. They are now computed
     per row from that row's own organisation — see `rowCan` in the table
     below. Grading every row by the company on screen was the whole reason
     administering another organisation meant switching to it first. */
  /* NOTE: `canEdit` used to live here — one grade, taken in the ACTIVE
     company, that decided whether the Edit access button was drawn on every
     row. It is gone rather than merely unused: the row asks `rowCan` about its
     own organisation instead, which is the whole point of this screen being
     able to show more than one. */

  /**
   * The organisations whose rosters this account may read.
   *
   * `user:read` and not "every organisation I can reach": membership grants
   * reach, roles grant permission, and neither implies the other — a person
   * can belong to a tenant and hold nothing in it. Offering such an
   * organisation in the picker would be offering a list that can only 403.
   */
  const adminOrgs = useMemo(
    () => (orgs ?? []).filter((o) => canIn(o.id, "user:read")),
    [orgs, canIn],
  );

  /**
   * Keep `scope` on something real.
   *
   * Two ways it goes stale: the company switcher moves under us, and the
   * account loses a grant between loads. ALL_ORGS survives both — it is a
   * choice the administrator made and re-pointing it because the header moved
   * would undo that choice for no reason. A named organisation that has
   * dropped off `adminOrgs` falls back to the active company.
   */
  useEffect(() => {
    if (scope === ALL_ORGS) return;
    if (scope && adminOrgs.some((o) => o.id === scope)) return;
    setScope(orgId ?? adminOrgs[0]?.id ?? null);
  }, [scope, adminOrgs, orgId]);

  /** The organisations the current scope actually reads. */
  const scopeIds = useMemo(() => {
    if (scope === ALL_ORGS) return adminOrgs.map((o) => o.id);
    return scope ? [scope] : [];
  }, [scope, adminOrgs]);

  /** Stable across re-renders that did not change the set, so the fetch below
   *  does not re-run on every keystroke in the search box. */
  const scopeKey = scopeIds.join(",");

  /** Is the Organisation column worth its width? Only when rows can differ. */
  const showOrgColumn = scopeIds.length > 1;

  const orgNameById = useMemo(
    () => new Map((orgs ?? []).map((o) => [o.id, o.name])),
    [orgs],
  );

  /* The whole organisation, not its name: the badge needs `code` to find the
     artwork, and the name to fall back on. */
  const orgById = useMemo(
    () => new Map((orgs ?? []).map((o) => [o.id, o])),
    [orgs],
  );

  // The current organisation starts selected: it is the one being administered
  // and unticking it is a deliberate act, not a default.
  useEffect(() => {
    if (orgId) setPicked((p) => (orgId in p ? p : { ...p, [orgId]: [] }));
  }, [orgId]);

  /**
   * The role list comes from the organisation being administered. The role is
   * the same everywhere the person belongs, and the server refuses a role that
   * one of their other organisations does not have, naming it.
   */
  const wantedOrgIds = useMemo(() => (orgId ? [orgId] : []), [orgId]);

  useEffect(() => {
    if (!canAssignRoles) return undefined;
    let cancelled = false;
    const missing = wantedOrgIds.filter((id) => !(id in rolesByOrg));
    if (missing.length === 0) return undefined;

    Promise.all(missing.map(async (id) => [id, await listAssignableRoles(id).catch(() => [])]))
      .then((pairs) => {
        if (cancelled) return;
        setRolesByOrg((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      });
    return () => { cancelled = true; };
  }, [wantedOrgIds, rolesByOrg, canAssignRoles]);

  /**
   * One fetch for however many organisations the scope names.
   *
   * `listUsersAcrossOrgs` is used even for a single organisation, rather than
   * branching to `listOrgUsers`. The one-org path is the common case and the
   * many-org path is the rare one, so if they were different code the rare one
   * would be the one nobody exercises — and, more concretely, only the
   * cross-org call stamps `scopeOrgId` onto each row. Every row must carry it,
   * because every row's buttons are addressed by it.
   *
   * The cache key carries the whole scope: a cached "all organisations" roster
   * handed to a single-organisation view would show people who are not there.
   */
  const { data, loading, error: loadError, retry, revalidate, mutate } = useApiData(
    () => listUsersAcrossOrgs(scopeIds),
    [scopeKey],
    { cacheKey: `ft-org-users:${scopeKey}` },
  );

  /* Memoised so the `?? []` fallback does not hand the filters below a brand
     new empty array on every render — which would re-run all three of them
     for a roster that has not changed. */
  const users = useMemo(() => data?.users ?? [], [data]);

  /**
   * Search first, then the facets — and the counts come from BETWEEN the two.
   *
   * `counts` is tallied over the searched list rather than the whole roster,
   * so "Active 3" means "three of the people matching what you typed", which
   * is what the number is asked to mean when you are about to click it.
   * Tallying the full roster instead would offer a chip that promises eight
   * and delivers three.
   */
  const needle = query.trim().toLowerCase();

  const searched = useMemo(
    () => users.filter((u) => matchesQuery(u, needle)),
    [users, needle],
  );

  const counts = useMemo(() => {
    const tally = { all: searched.length };
    for (const u of searched) {
      const key = accountState(u).key;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, [searched]);

  /**
   * The roster's own shape, taken before ANY filter.
   *
   * Not `counts` above, which is tallied over the searched list because the
   * chips it feeds are what the search has left to offer. This one is the
   * masthead's, and a masthead that changed its totals as you typed would be
   * reporting the search rather than the roster.
   */
  const roll = useMemo(() => {
    const tally = { all: users.length, active: 0, suspended: 0 };
    for (const u of users) {
      const key = accountState(u).key;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, [users]);

  /** Only roles somebody actually holds here. A picker offering every
   *  assignable role would list options that can only return nothing. */
  const roleOptions = useMemo(() => {
    const held = new Set();
    for (const u of users) for (const name of rolesFor(u)) held.add(name);
    return [...held].sort((a, b) => a.localeCompare(b));
  }, [users]);

  const shown = useMemo(() => searched.filter((u) => {
    if (statusKey !== "all" && accountState(u).key !== statusKey) return false;
    if (roleName === NO_ROLE) return rolesFor(u).length === 0;
    if (roleName !== "any" && !rolesFor(u).includes(roleName)) return false;
    return true;
  }), [searched, statusKey, roleName]);

  const filtering = needle !== "" || statusKey !== "all" || roleName !== "any";

  /* ── From the filtered list to the page on screen ───────────────────────
     Three steps, in this order and no other: sort the whole filtered list,
     then cut a page out of it, then read the selection against that page.
     Sorting after paging would sort fifteen rows and call it a sorted roster,
     which is the classic version of this bug. */
  const sortAccessors = useMemo(() => ({
    name:     (u) => u.fullName,
    // Null rather than "", so rosterView pins the people with no address to
    // the end in both directions instead of sorting them under the As.
    email:    (u) => u.email || null,
    phone:    (u) => u.phone || null,
    org:      (u) => orgNameById.get(u.scopeOrgId) ?? "",
    roles:    (u) => rolesFor(u).join(", "),
    status:   (u) => accountState(u).label,
    created:  (u) => (u.createdAt ? new Date(u.createdAt).getTime() : null),
    // Never-set sorts as empty, which rosterView pins to the end in both
    // directions — "no password" is not "the oldest password".
    password: (u) => ((u.passwordChangeCount ?? 0) === 0
      ? null
      : (u.passwordChangedAt ? new Date(u.passwordChangedAt).getTime() : null)),
  }), [orgNameById]);

  const sorted = useMemo(
    () => sortRows(shown, sort, sortAccessors),
    [shown, sort, sortAccessors],
  );

  /* The board and the list show the whole filtered roster; only the table
     pages. Paging a board would hide a whole column's worth of "who is stuck",
     which is the single question the board exists to answer. */
  const paged = useMemo(
    () => paginate(sorted, page, perPage),
    [sorted, page, perPage],
  );

  const rowsOnScreen = view === "table" ? paged.slice : sorted;
  const visibleIds = useMemo(() => rowsOnScreen.map(rowKey), [rowsOnScreen]);

  /* Filtering to page 3 of a list that now has one page is not an edge case,
     it is what happens every time somebody types in the search box. paginate
     clamps the number it RETURNS; this puts the clamp back into state so the
     pager's own buttons agree with what is drawn. */
  useEffect(() => {
    if (paged.page !== page) setPage(paged.page);
  }, [paged.page, page]);

  useEffect(() => { setPage(1); }, [needle, statusKey, roleName, scope, perPage]);

  /* A selection must never outlive the evidence for it: narrowing the roster
     and then hitting a bulk action would otherwise act on people the
     administrator can no longer see. */
  const shownIds = useMemo(() => shown.map(rowKey), [shown]);
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = pruneSelection(prev, shownIds);
      return next.size === prev.size ? prev : next;
    });
  }, [shownIds]);

  const headState = selectionState(selected, visibleIds);

  const selectedUsers = useMemo(
    () => shown.filter((u) => selected.has(rowKey(u))),
    [shown, selected],
  );

  /* Which columns are drawn. The organisation column is still governed by
     whether there is more than one on screen — hiding it by hand is a
     preference, but showing it when there is only one tenant would be a column
     of the same word repeated. */
  const columns = useMemo(
    () => COLUMNS.filter((c) => {
      if (c.key === "org" && !showOrgColumn) return false;
      return c.always || !hiddenCols.has(c.key);
    }),
    [showOrgColumn, hiddenCols],
  );

  const toggleColumn = useCallback((key) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const clickSort = useCallback((key) => {
    setSort((prev) => nextSort(prev, key));
  }, []);

  /** Is this column currently drawn? Read by the cells, so head and body
   *  cannot disagree about how many columns there are. */
  const shows = useCallback(
    (key) => columns.some((c) => c.key === key),
    [columns],
  );

  /* Straight into the panel. This used to switch to the table view and
     compute which page the person was on, because the editor was a row that
     opened underneath them and could not be reached from anywhere else. A
     panel has no page and no view, so the board and the list now open the same
     editor without moving the reader somewhere they did not ask to go. */
  const jumpTo = openEditor;

  /* Close an open menu on Escape or on a click elsewhere. Both, because a
     popover that only closes on its own button is a popover you have to
     remember to put away. */
  useEffect(() => {
    if (!openMenu) return undefined;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpenMenu(null); } };
    const onDown = (e) => { if (!e.target.closest?.(".ua-menu")) setOpenMenu(null); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [openMenu]);

  /* ── Export ──────────────────────────────────────────────────────────────
     What is on screen: the current filters, the current sort, the current
     columns. A file that disagrees with the page it was taken from is worse
     than no file. The whole SORTED list rather than the current page, because
     nobody means "these fifteen" when they click Export. */
  const handleExport = useCallback(() => {
    const cols = columns.map((c) => ({
      key: c.key,
      label: c.key === "name" ? "Full name" : c.label,
      value: (u) => {
        switch (c.key) {
          case "name":     return u.fullName;
          case "email":    return u.email ?? "";
          case "phone":    return u.phone ?? "";
          case "org":      return orgNameById.get(u.scopeOrgId) ?? "";
          case "group":    return u.group?.name ?? "";
          case "roles":    return rolesFor(u).join("; ");
          case "status":   return accountState(u).label;
          case "created":  return fmtDate(u.createdAt);
          case "password": return (u.passwordChangeCount ?? 0) === 0
            ? "never set" : fmtDate(u.passwordChangedAt);
          default:         return "";
        }
      },
    }));
    /* Email rides along even when its column is hidden: an export of a roster
       with no way to contact anybody in it is a list of names. It is a real
       column now, so this only adds it back when it has been switched off —
       inserting it unconditionally would have printed it twice. */
    if (!columns.some((c) => c.key === "email")) {
      cols.splice(1, 0, { key: "email", label: "Email", value: (u) => u.email ?? "" });
    }
    const scopeName = scope === ALL_ORGS
      ? "all organisations"
      : (orgNameById.get(scope) ?? activeCompany?.name ?? "roster");
    downloadCsv(toCsv(sorted, cols), exportFilename(scopeName));
    setOpenMenu(null);
  }, [columns, sorted, orgNameById, scope, activeCompany]);

  /* ── Bulk actions ────────────────────────────────────────────────────────
     Sequential, not Promise.all: these are writes against a shared roster and
     firing fifty at once is how an admin API earns a rate limit. Each is
     graded in the row's OWN organisation, the same rule the per-row buttons
     follow, so a selection spanning two tenants does only what the server
     would have allowed one at a time.

     There is no bulk DELETE and there will not be one. Deleting an account
     here requires typing a phrase per person, deliberately, and a checkbox
     column is the exact opposite of that. */
  const runBulk = useCallback(async (users, fn, describe, undo = null, tone = "ok") => {
    if (users.length === 0 || bulkBusy) return;
    setBulkBusy(true); setError("");
    let done = 0;
    const failed = [];
    for (const u of users) {
      try { await fn(u); done += 1; }
      catch { failed.push(u.fullName); }
    }
    setBulkBusy(false);
    setSelected(new Set());
    retry();
    if (failed.length > 0) {
      /* A partial result is a STATE, not an event: it names people who are
         still as they were, and it has to stay on screen until it is read.
         No undo offered either -- half a set went through, and "undo" would
         have to mean "put back the ones that moved", which is not what the
         word promises. */
      fail(`${describe(done)} ${failed.length} could not be changed: ${failed.join(", ")}.`);
    } else {
      say(describe(done), undo, tone);
    }
    return { done, failed };
  }, [bulkBusy, retry, say, fail]);

  const bulkSetStatus = useCallback(async (next) => {
    const targets = selectedUsers.filter((u) => u.status !== next
      && canIn(u.scopeOrgId, "user:update"));
    if (targets.length === 0) return;
    const before = targets.map((u) => ({ user: u, status: u.status }));
    /* The undo is the reason this action needs no confirmation in front of it.
       It replays the previous status per person rather than flipping the whole
       set back, because the set was not uniform to begin with.

       Handed to runBulk rather than raised beside it: the old code ran both,
       so a bulk suspend reported itself twice -- once in the page strip and
       once in a toast -- and the toast counted the TARGETS while the strip
       counted what actually went through. One report, one number, the one
       that is true. */
    await runBulk(
      targets,
      (u) => setUserStatus(u.scopeOrgId, u.id, next),
      (done) => `${done} ${done === 1 ? "account" : "accounts"} ${next === "SUSPENDED" ? "suspended" : "reactivated"}.`,
      async () => {
        setToast(null);
        for (const { user, status } of before) {
          try { await setUserStatus(user.scopeOrgId, user.id, status); } catch { /* reported by the reload */ }
        }
        retry();
      },
      next === "SUSPENDED" ? "suspended" : "ok",
    );
  }, [selectedUsers, runBulk, canIn, retry]);

  const bulkResend = useCallback(async () => {
    // Only where an invitation is still the thing in the way. The server
    // refuses to re-invite an account that already has a password, so
    // including those would be queueing calls that can only fail.
    const targets = selectedUsers.filter((u) => accountState(u).key !== "active" && u.email);
    await runBulk(
      targets,
      (u) => resendInvite(u.scopeOrgId, u.id),
      (done) => `${done} ${done === 1 ? "invitation" : "invitations"} sent again.`,
      null,
      "created",
    );
  }, [selectedUsers, runBulk]);

  /* The toast clears itself. Long enough to read and reach, short enough that
     it is gone before it becomes furniture. */
  useEffect(() => {
    if (!toast || toast.tone !== "ok") return undefined;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toast]);

  const clearFilters = useCallback(() => {
    setQuery(""); setStatusKey("all"); setRoleName("any");
    searchRef.current?.focus();
  }, []);

  const set = useCallback((key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
  }, []);

  function toggleOrg(id) {
    setPicked((p) => {
      const next = { ...p };
      if (id in next) delete next[id];
      else next[id] = [];
      return next;
    });
  }

  const selectedOrgIds = useMemo(() => Object.keys(picked), [picked]);
  /* Platform roles are granted to an existing account, from its editor, not
     made at sign-up: the create route refuses them. */
  const createChoices = useMemo(
    () => (rolesByOrg[orgId] === undefined ? undefined : rolesByOrg[orgId].filter((r) => !r.platform)),
    [rolesByOrg, orgId],
  );

  async function handleCreate(e) {
    e.preventDefault();
    if (busy || !form.fullName.trim() || !form.email.trim() || selectedOrgIds.length === 0) return;
    setBusy(true); setError("");
    try {
      // The org being administered is the path organisation; anything else the
      // admin ticked rides along as an extra membership with its own roles.
      const extras = selectedOrgIds
        .filter((id) => id !== orgId)
        .map((id) => ({ organisationId: id, roleSlugs: createRoles, allVehicles: true }));

      const result = await createOrgUser(orgId, {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        employeeId: form.employeeId.trim(),
        roleSlugs: createRoles,
        memberships: extras,
      });

      const where = selectedOrgIds.length === 1
        ? (activeCompany?.name ?? "this organisation")
        : `${selectedOrgIds.length} organisations`;

      if (result?.created === false) {
        say(`That address already has an account. They have been added to ${where}.`, null, "created");
      } else if (result?.invite?.link) {
        // samad-server sends no email: it hands back the set-password link,
        // and the administrator passes it on.
        flag(shareLinkNotice(`Account created for ${form.email.trim()}.`, result.invite));
      } else if (result?.invite?.sent) {
        say(`Invitation sent to ${form.email.trim()} · added to ${where}.`, null, "created");
      } else if (result?.invite?.reason === "queued") {
        /* Queued is NOT the failure branch below, and putting it there would be
           the worst misreport on this screen: it tells an administrator the
           person cannot sign in, when the link is in flight with three attempts
           behind it. It is not the success branch either — nothing has left
           the building yet, and "sent" is what someone reads before deciding
           whether to chase it. */
        say(`Account created and added to ${where}. The invitation to ${form.email.trim()} is queued for delivery.`, null, "created");
      } else if (result && result.invite === undefined) {
        // No `invite` key AT ALL means the API that answered predates
        // invitations — it created the account the old way and sent nothing.
        // Reporting that as reason "unknown" sent people looking for a mail
        // failure that never happened.
        flag(
          `Account created, but this server cannot send invitations yet, it is running an older build. ` +
          `${form.email.trim()} has no way to sign in until it is updated and they receive a link.`,
        );
      } else {
        // The honest version of a failure that would otherwise be invisible:
        // the account exists but nobody can sign in to it.
        const why = {
          unconfigured: "email is not configured on the server",
          "send-failed": "the mail server rejected it",
          "no-email": "the account has no email address",
          "account-already-active": "that account already has a password",
          "not-requested": "no invitation was requested",
        }[result?.invite?.reason] ?? result?.invite?.reason ?? "reason not reported";
        flag(
          `Account created, but the invitation could not be sent, ${why}. ` +
          `They cannot sign in until they receive a link.`,
        );
      }

      setForm(EMPTY_FORM);
      setPicked(orgId ? { [orgId]: [] } : {});
      setCreateRoles([]);
      /* Show the person who was just created.
         A new account is Pending with whatever roles were ticked, so a filter
         left on "Suspended", or on a role they do not hold, would hide the row
         the invitation just added — the notice would say it worked and the
         roster would appear not to have changed. Clearing is the smaller
         surprise, and it only happens on success. */
      setQuery(""); setStatusKey("all"); setRoleName("any");
      retry();
      /* Closed on success only. A failure keeps the panel up with the typing
         still in it, because the one thing worse than a rejected form is a
         rejected form that threw the answers away. */
      closeInvite();
    } catch (err) {
      fail(isMissingEndpoint(err)
        ? "Creating users is not available yet, this server does not have the account API."
        : firstMessage(err, "email", "Could not create that user."));
    } finally {
      setBusy(false);
    }
  }

  async function handleResend(user) {
    setRowBusy(rowKey(user)); setError("");
    try {
      const invite = await resendInvite(user.scopeOrgId, user.id);
      if (invite?.link) {
        flag(shareLinkNotice(`New link for ${user.email}; the previous one no longer works.`, invite));
      } else if (invite?.sent) {
        say(`New invitation sent to ${user.email}.`, null, "created");
      } else if (invite?.reason === "queued") {
        say(`New invitation to ${user.email} is queued for delivery.`, null, "created");
      } else {
        /* Not a toast: nothing was sent, so this is a thing that is still
           wrong rather than a thing that happened. */
        flag(`Could not send the invitation (${invite?.reason ?? "unknown"}).`);
      }
    } catch (err) {
      fail(firstMessage(err, null, "Could not resend that invitation."));
    } finally {
      setRowBusy(null);
    }
  }

  /* `next` is a parameter rather than always a flip, because the board drops a
     card ONTO a state: "make this suspended" is the gesture, and a toggle
     would make the outcome depend on what the card was when the drag began
     rather than on where it was let go. */
  async function handleStatus(user, next = user.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE") {
    if (user.status === next) return;
    setRowBusy(rowKey(user)); setError("");
    try {
      await setUserStatus(user.scopeOrgId, user.id, next);
      /* With its undo, for the same reason the bulk actions have one: this
         is reachable by dropping a card on a column, which is a gesture you
         can start by accident, and putting somebody back is one request. */
      say(
        next === "SUSPENDED"
          ? `${user.fullName} has been suspended and signed out.`
          : `${user.fullName} has been reactivated.`,
        async () => {
          setToast(null);
          try {
            await setUserStatus(user.scopeOrgId, user.id, user.status);
            setEditUser((p) => (p && p.id === user.id ? { ...p, status: user.status } : p));
          } catch { /* reported by the reload */ }
          retry();
        },
        next === "SUSPENDED" ? "suspended" : "ok",
      );
      /* The open panel holds a SNAPSHOT, so the refresh below cannot reach it.
         Without this the badge inside the panel still reads Active a second
         after the button that suspended them said it worked. */
      setEditUser((p) => (p && p.id === user.id ? { ...p, status: next } : p));
      retry();
    } catch (err) {
      fail(firstMessage(err, null, "Could not change that account."));
    } finally {
      setRowBusy(null);
    }
  }

  /* ── Dragging a card between columns ──────────────────────────────────────
   *
   * The board already groups people by whether they can sign in, so the two
   * columns an administrator moves somebody BETWEEN are on screen beside each
   * other. Dropping a card into Suspended is the same request the panel's
   * Suspend button makes, said in the place you are already looking.
   *
   * Only Active and Suspended take a drop. Pending and "No live invite" are
   * DERIVED — they describe an invitation, not a field — and there is no
   * request that puts somebody into them, so they must not look like targets.
   *
   * The dragged person is held in a ref as well as in state: the state is what
   * the columns are styled from, and the ref is what the drop reads, because
   * a drop handler that re-derived the person from dataTransfer would be
   * parsing a string it wrote itself.
   */
  const dragRef = useRef(null);
  const [dragKey, setDragKey] = useState(null);
  const [dropCol, setDropCol] = useState(null);

  /* Never yourself. The panel's Suspend button will still do it if that is
     genuinely what you want, but a gesture this easy to start by accident
     should not be able to sign you out of the screen you are standing on. */
  const canDrag = useCallback(
    (u) => canIn(u.scopeOrgId, "user:update") && u.id !== me?.id,
    [canIn, me],
  );

  /** Would a drop on this column actually change anything? */
  const dropTarget = useCallback((tabKey) => {
    const u = dragRef.current;
    if (!u) return false;
    if (tabKey !== "active" && tabKey !== "suspended") return false;
    return u.status !== (tabKey === "suspended" ? "SUSPENDED" : "ACTIVE");
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDragKey(null);
    setDropCol(null);
  }, []);

  // ── Destroying an account ────────────────────────────────────────────────

  function openDelete(user) {
    setConfirmText("");
    setError("");
    setDeleting((key) => (key === rowKey(user) ? null : rowKey(user)));
    // Closing the access editor: the two panels are about the same row and
    // both are tall, so having them open together pushes the person they
    // describe off the top of the screen.
    setEditing(null);
  }

  /**
   * Permanent, and said so in every word on screen.
   *
   * The failures worth naming separately are the server's REFUSALS — you
   * cannot delete yourself, somebody whose home is another organisation, or
   * anybody carrying operations history. Each arrives as a 409 whose message
   * already names the reason and its numbers, so it is shown as written rather
   * than replaced with a house sentence that would say less.
   */
  async function handleDelete(user) {
    if (deleteBusy) return;
    setDeleteBusy(true); setError("");
    try {
      const gone = await deleteOrgUserPermanently(user.scopeOrgId, user.id);
      const also = [
        gone?.removed?.roles    ? `${gone.removed.roles} role grant${gone.removed.roles === 1 ? "" : "s"}` : null,
        gone?.removed?.sessions ? `${gone.removed.sessions} session${gone.removed.sessions === 1 ? "" : "s"}` : null,
        gone?.removed?.invites  ? `${gone.removed.invites} invitation${gone.removed.invites === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      /* No undo on this one, and the sentence says why. The toast is still
         the right shape for it: the account is gone from the list behind it,
         which is the reporting; this is the receipt. */
      say(
        `${user.fullName} has been permanently deleted`
        + (also.length ? `, with ${also.join(", ")}.` : ".")
        + " This cannot be undone.",
        null,
        "deleted",
      );
      setDeleting(null);
      setConfirmText("");

      /* The list is corrected from what we know, not from what the server says
         next — and the cache with it.
         `retry()` would have been the obvious call and is the wrong one here.
         It blanks the roster and repaints it as "Loading…" to tell the reader
         something they just watched happen, and it leaves a window in which
         the cached copy still holds the deleted person: this hook keeps the
         last good data when a refresh fails, so one flaky request after a
         successful delete would put the account back on screen and back in
         localStorage, where it survives a reload and outlives the row itself.
         A delete has exactly one possible effect on a list, so it is applied
         directly; the server is asked afterwards, quietly, in case anything
         else moved. */
      mutate((prev) => (prev ? {
        ...prev,
        /* The PAIR, not the id: the same person may be on this list once for
           each organisation they belong to, and deleting them from one does
           not remove them from another. */
        users: (prev.users ?? []).filter((row) => rowKey(row) !== rowKey(user)),
        total: Math.max(0, (prev.total ?? 1) - 1),
      } : prev));
      revalidate();
    } catch (err) {
      fail(isMissingEndpoint(err)
        ? "Permanent deletion is not available yet, this server does not have the account API."
        : firstMessage(err, null, "Could not delete that account."));
    } finally {
      setDeleteBusy(false);
    }
  }

  // ── Editing one person's access ──────────────────────────────────────────

  /**
   * Open one person, whole.
   *
   * Their details come off the row, which already carries every field the
   * update endpoint accepts; their access is read fresh, because the roster
   * only ever knows about the organisations it was scoped to and this panel
   * offers to change all of them.
   *
   * No toggle. It used to close if you clicked the row you already had open,
   * which made sense when it was a strip in the table and makes none for a
   * modal panel covering the row you would be clicking.
   */
  async function openEditor(user) {
    const identity = {
      fullName:   user.fullName ?? "",
      email:      user.email ?? "",
      phone:      user.phone ?? "",
      employeeId: user.employeeId ?? "",
    };
    setEditing(rowKey(user));
    setEditUser(user);
    setEditIdentity(identity);
    setEditForm(identity);
    setEditStatus(user.status ?? "ACTIVE");
    setEditBase(null);
    setEditDraft({});
    setEditRolesBase(null);
    setEditRoles([]);
    setError("");
    try {
      const memberships = await listUserMemberships(user.scopeOrgId, user.id);
      const asDraft = Object.fromEntries(
        memberships.map((m) => [m.organisationId, (m.roles ?? []).map((r) => r.slug)]),
      );
      setEditBase(asDraft);
      setEditDraft(asDraft);
      /* Every role they hold anywhere, platform included, once each. */
      const held = new Map();
      for (const m of memberships) for (const r of m.roles ?? []) held.set(r.slug, r);
      setEditRolesBase([...held.values()]);
      setEditRoles([...held.keys()]);
    } catch (err) {
      closeEditor();
      fail(isMissingEndpoint(err)
        ? "Editing access is not available yet, this server does not have the membership API."
        : firstMessage(err, null, "Could not read that person's access."));
    }
  }

  /* Only the key is cleared. `editUser` is what the panel is DRAWN from, and
     it has to survive the two hundred milliseconds the panel spends sliding
     out — clearing it here emptied the panel first and animated the empty
     box. The next open replaces it. */
  const closeEditor = useCallback(() => setEditing(null), []);

  const editField = (key) => (e) =>
    setEditForm((f) => ({ ...f, [key]: e.target.value }));

  function toggleEditOrg(id) {
    setEditDraft((d) => {
      const next = { ...d };
      if (id in next) delete next[id];
      else next[id] = [];
      return next;
    });
  }

  /**
   * Write only what changed, and write removals last.
   *
   * Removals last so a mistake cannot strand somebody: if a grant fails, the
   * access they already had is still there. Doing it the other way round could
   * leave a person with nothing when the second half of the save threw.
   *
   * Each organisation is one PUT carrying the COMPLETE set of roles it should
   * end with — that is how one call both adds a role and takes another away,
   * and it is why the unchanged organisations are skipped rather than resent.
   */
  /**
   * May this administrator change this person's own details?
   *
   * Two conditions, and the second is not a nicety. `PATCH .../users/:userId`
   * matches on the HOME organisation column, so it can only be addressed to
   * the organisation the person belongs to — and the administrator has to
   * hold `user:update` THERE, not merely on the roster they are reading. An
   * admin at one site looking at a visiting member from another cannot rename
   * them, and the panel says so rather than offering a field that 403s.
   */
  function identityEditable(user) {
    const home = user?.organisationId;
    if (!home) return false;
    if (!orgs.some((o) => o.id === home)) return false;
    return canIn(home, "user:update");
  }

  async function saveEditor(user) {
    if (!editBase) return;
    const before = editBase;
    const after = editDraft;

    const same = (a = [], b = []) =>
      a.length === b.length && [...a].sort().join() === [...b].sort().join();

    /* Organisations decide where they belong; the role is one, everywhere.
       New organisations are joined first and the role then set once, which
       also brings every existing organisation and any platform role in line. */
    const toWrite = Object.keys(after).filter((id) => !(id in before));
    const toRemove = Object.keys(before).filter((id) => !(id in after));
    const roleChanged = editRolesBase != null && !same(editRolesBase.map((r) => r.slug), editRoles);

    /* What they typed about the person themselves, minus anything they did
       not touch. Trimmed here rather than on the way out, so "  " does not
       count as a change and does not arrive at a schema whose floor is two
       characters. */
    const identity = {};
    for (const key of ["fullName", "phone", "employeeId"]) {
      const now = editForm[key].trim();
      if (now !== (editIdentity[key] ?? "").trim()) identity[key] = now;
    }
    const identityChanged = Object.keys(identity).length > 0;
    const statusChanged = editStatus != null && editStatus !== user.status;

    if (identityChanged && !identity.fullName && editForm.fullName.trim() === "") {
      // Guarded here as well as by `required`: the panel can be saved from the
      // foot without the field ever being focused.
      setError("A name is required.");
      return;
    }

    if (!identityChanged && !statusChanged && !roleChanged && toWrite.length === 0 && toRemove.length === 0) {
      closeEditor(); return;
    }

    if ((roleChanged || toWrite.length) && editRoles.length === 0) {
      setError("Choose a role.");
      return;
    }

    if (toRemove.length && Object.keys(after).length === 0) {
      setError("Somebody must belong to at least one organisation. Suspend the account instead.");
      return;
    }

    setEditBusy(true); setError("");
    try {
      /* Their details first, access second. If the second half throws, the
         person is renamed and their access is untouched — which is the harmless
         order. The other way round leaves access changed under the old name,
         and no way to tell from the roster that anything half-happened. */
      if (identityChanged) await updateOrgUser(user.organisationId, user.id, identity);

      for (const id of toWrite) await setUserMembership(id, user.id, []);
      if (roleChanged || toWrite.length) await setUserRole(user.scopeOrgId, user.id, editRoles);
      for (const id of toRemove) await removeUserMembership(id, user.id);

      /* Suspension LAST, and after the removals, because it is the one write
         that can end the session being used to make the others. Suspending
         somebody first and then failing to save their access leaves an
         account locked out AND half-edited. */
      if (statusChanged) await setUserStatus(user.scopeOrgId, user.id, editStatus);

      const named = (ids) => ids
        .map((id) => orgs.find((o) => o.id === id)?.name ?? "an organisation")
        .join(", ");
      const parts = [];
      if (identityChanged) parts.push(`details updated`);
      if (statusChanged) {
        parts.push(editStatus === "SUSPENDED"
          ? "suspended and signed out"
          : "reactivated");
      }
      if (roleChanged) {
        const names = editRoles.map((slug) =>
          (rolesByOrg[orgId] ?? []).find((r) => r.slug === slug)?.name
          ?? editRolesBase.find((r) => r.slug === slug)?.name ?? slug);
        parts.push(`now ${names.join(", ")} in every organisation`);
      }
      if (toWrite.length) parts.push(`added to ${named(toWrite)}`);
      if (toRemove.length) parts.push(`removed from ${named(toRemove)}`);
      say(`${identity.fullName ?? user.fullName}: ${parts.join("; ")}.`);

      closeEditor();
      retry();
    } catch (err) {
      fail(firstMessage(err, null, "Could not save that change. Some of it may have been applied."));
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <div className="ua-page">
      <div className="ua-page__inner">
        {/* No page title: the crumb in the screen's bar above already names
            this page, and you arrived by clicking the same words in the avatar
            menu. What the band carries instead is the Maintenance tab's own
            opening statement — whose data this is, on the left, and the figures
            the page exists for as KPI tiles on the right.

            The second tile appears only while a filter is on, which is what
            makes a short roster explain itself: 4 showing, of 12. */}
        {/* ── Masthead ──────────────────────────────────────────────────
            The page gets a title. It opened on a bare organisation name for
            several revisions on the reasoning that the crumb above already
            names it — true, but a crumb is navigation read once on arrival,
            not a heading, and the page had nothing at its top edge for the eye
            to land on.

            The count rides the title as a badge rather than sitting beside it
            as a tile. It is an attribute OF the title, not a statistic next to
            one, and the two KPI tiles it replaces were spending a whole band
            on a number and its own synonym. */}
        <header className="ua-masthead">
          <div className="ua-masthead__head">
            {/* The heading is read, not seen. The crumb strip directly above
                this panel already says "User accounts" — printing it again
                underneath was the page naming itself twice — but a screen
                reader arriving here still needs one heading to land on, and a
                page whose only title is a breadcrumb <li> has none. */}
            <h1 className="ua-masthead__title">Users</h1>

            {/* Two badges instead of a total and a paragraph.
                The total said how many rows there are, which is a fact you can
                also get by looking at them; the paragraph explained what a
                roster is to somebody already reading one. What neither said is
                the thing an administrator opens this page to find out — how
                many of these people can actually get in, and how many are
                shut out — and that is two numbers, not three hundred words.

                Same badge as the Status column, deliberately: one voice for
                "a state" across the page, so the summary and the row it
                summarises are recognisably the same fact at two scales. */}
            {!loading && (
              <p className="ua-masthead__roll">
                <span className="ua-badge ua-badge--active">
                  <span className="ua-state__dot" aria-hidden="true" />
                  {roll.active} active
                </span>
                {/* Drawn at zero too. "Nobody here is suspended" is something
                    somebody came to learn, and a badge that vanishes when it
                    reaches zero makes its own absence unreadable. */}
                <span className="ua-badge ua-badge--suspended">
                  <span className="ua-state__dot" aria-hidden="true" />
                  {roll.suspended} suspended
                </span>
                {/* The one job the old count did that nothing else does: a
                    short roster explaining that it is short because of a
                    filter, rather than because the fleet is small. */}
                {filtering && (
                  <span className="ua-masthead__showing">
                    {shown.length} of {roll.all} shown
                  </span>
                )}
              </p>
            )}
          </div>

          {/* The scope picker replaces the flat company name once there is
              more than one organisation to administer. With only one it stays
              a label, because a select with a single option is a control that
              cannot do anything. */}
          {adminOrgs.length > 1 ? (
            <label className="ua-header__scope">
              <span className="ua-header__scopelabel">People in</span>
              <select
                className="ua-header__scopesel"
                value={scope ?? ""}
                onChange={(e) => {
                  /* Closing both panels: they are about a row that is about to
                     stop existing on screen, and an editor left open over a
                     different organisation's roster would write to the wrong
                     membership. */
                  setEditing(null); setDeleting(null); setConfirmText("");
                  setError("");
                  setScope(e.target.value);
                }}
              >
                {adminOrgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}{o.id === orgId ? " (current)" : ""}
                  </option>
                ))}
                <option value={ALL_ORGS}>All organisations ({adminOrgs.length})</option>
              </select>
            </label>
          ) : (
            <span className="ua-header__org">
              {adminOrgs[0]?.name ?? activeCompany?.name ?? "Fleet"}
            </span>
          )}

          {loading && <span className="ua-kpi__loading">Loading…</span>}
        </header>

        {/* ── Toolbar ───────────────────────────────────────────────────────
            Views on the left, everything that acts on the view on the right.
            The split is not decoration: the left control changes what SHAPE
            you are looking at, the right ones change what is in it or take it
            away with you. Two kinds of verb, two sides. */}
        <div className="ua-toolbar">
          <div className="ua-views" role="group" aria-label="How to show the roster">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                className={"ua-views__opt" + (view === v.key ? " ua-views__opt--on" : "")}
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
              >
                <ViewIcon kind={v.key} />
                {v.label}
              </button>
            ))}
          </div>

          <div className="ua-toolbar__right">
            <div className="ua-search">
              {/* Drawn here rather than imported. The app ships no icon set,
                  and the Maintenance filter bar draws its own magnifier the
                  same way — two elements, so the pair cannot fall out of
                  step. */}
              <svg className="ua-search__icon" width="13" height="13" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                className="ua-search__input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Escape clears rather than closing anything: this input is
                // not a dialog, and a search box that throws away the screen
                // on Escape is the behaviour nobody wants twice.
                onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
                placeholder="Search name, email or ID"
                aria-label="Search people"
                autoComplete="off"
              />
              {query && (
                <button type="button" className="ua-search__clear"
                        onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
                  Clear
                </button>
              )}
            </div>

            {/* The masking switch.
                Labelled with what clicking it DOES, not with the state it is
                in — "Masked" on a button is a word you have to work out the
                mood of. `aria-pressed` carries the state for anybody who
                needs it stated rather than implied. */}
            <button
              type="button"
              className={"ua-tbtn" + (masked ? "" : " ua-tbtn--on")}
              aria-pressed={!masked}
              onClick={toggleMasking}
              title={masked
                ? "Email and phone are hidden. Show them for every row."
                : "Email and phone are in the clear. Hide them again."}
            >
              {masked ? "Show contacts" : "Hide contacts"}
            </button>

            {/* Columns. Named for what it holds rather than for what it does
                to them — a menu called "Hide" reads as an action on the thing
                you last clicked. */}
            <div className="ua-menu">
              <button
                type="button"
                className={"ua-tbtn" + (hiddenCols.size > 0 ? " ua-tbtn--on" : "")}
                aria-expanded={openMenu === "cols"}
                aria-haspopup="true"
                disabled={view !== "table"}
                title={view === "table" ? undefined : "Columns belong to the table view"}
                onClick={() => setOpenMenu((m) => (m === "cols" ? null : "cols"))}
              >
                Columns{hiddenCols.size > 0 ? ` (${columns.length})` : ""}
              </button>
              {openMenu === "cols" && (
                <div className="ua-menu__pop" role="group" aria-label="Columns">
                  <span className="ua-menu__label">Show in the table</span>
                  {COLUMNS.filter((c) => c.key !== "org" || showOrgColumn).map((c) => {
                    const on = c.always || !hiddenCols.has(c.key);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        className={"ua-menu__item" + (on ? " ua-menu__item--on" : "")}
                        role="checkbox"
                        aria-checked={on}
                        // The name column is the one that cannot go: a roster
                        // without it is a table of facts about nobody.
                        aria-disabled={c.always || undefined}
                        onClick={() => { if (!c.always) toggleColumn(c.key); }}
                      >
                        <span className="ua-menu__tick" aria-hidden="true">
                          <svg width="9" height="9" viewBox="0 0 12 12" fill="none"
                               stroke="currentColor" strokeWidth="2.4">
                            <path d="M2 6.4l2.6 2.6L10 3.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              className="ua-tbtn"
              onClick={handleExport}
              disabled={sorted.length === 0}
              title={sorted.length === 0
                ? "Nothing to export"
                : "Downloads what is on screen: these filters, this sort, these columns"}
            >
              Export
            </button>

            {/* Not a toggle any more. What it opens is a modal panel with a
                scrim over this toolbar, so the button cannot be clicked to
                close what is covering it — the panel carries its own way out,
                and Escape is the other one. */}
            <button
              type="button"
              className={"ua-invite-btn" + (inviteOpen ? " ua-invite-btn--open" : "")}
              aria-haspopup="dialog"
              aria-expanded={inviteOpen}
              aria-controls="ua-invite"
              onClick={openInvite}
            >
              Add user
            </button>
          </div>
        </div>

        {/* The controls, as one band under the count.
            Typed text first because it is the fastest way to one person;
            the state chips second because they are how you find a GROUP —
            everyone still waiting, everyone whose invitation lapsed — which
            is the other half of what this roster is read for. */}
        {/* The filter row keeps the chips and loses the search box, which
            moved into the toolbar above. Chips rather than dropdowns because
            a chip carries its own count: it says how many are behind it before
            you commit to opening it, which a select cannot. */}
        <div className="ua-filters">
          <div className="ua-filter-group">
            <span className="ua-filter-label" id="ua-state-label">State</span>
            <div className="ua-chips" role="group" aria-labelledby="ua-state-label">
            {STATUS_TABS.map((t) => {
              const n = counts[t.key] ?? 0;
              return (
                <button
                  key={t.key}
                  type="button"
                  className={"ua-chip" + (statusKey === t.key ? " ua-chip--on" : "")}
                  aria-pressed={statusKey === t.key}
                  // A chip that can only return an empty roster is not worth a
                  // click — but it stays on screen, because "nobody here is
                  // suspended" is itself something an administrator came to
                  // learn. The one exception is the chip already selected:
                  // disabling it would trap the filter on an empty result.
                  disabled={n === 0 && statusKey !== t.key}
                  onClick={() => setStatusKey(t.key)}
                >
                  {t.label}<span className="ua-chip__n">{n}</span>
                </button>
              );
            })}
            </div>
          </div>

          {/* Only rendered where it can mean something. One organisation with
              one role in use makes this a picker with a single choice. */}
          {roleOptions.length > 1 && (
            <div className="ua-filter-group">
              <span className="ua-filter-label" id="ua-role-label">Role</span>
              <label className="ua-rolepick">
                <select className="ua-rolepick__select" value={roleName}
                        aria-labelledby="ua-role-label"
                        onChange={(e) => setRoleName(e.target.value)}>
                  <option value="any">Any role</option>
                  {roleOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                  <option value={NO_ROLE}>No role here</option>
                </select>
              </label>
            </div>
          )}

          {/* Only when there is something to clear.
              This slot held a dimmed sentence explaining that state and role
              are the only facets — two faults in one element: it measured
              2.42:1, and it explained an absence nobody had asked about. The
              chips above already show what can be filtered. */}
          {filtering && (
            <button type="button" className="ua-addfilter" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

        {/* ── Selection ─────────────────────────────────────────────────────
            Inserted above the grid rather than swapped over the toolbar, so
            the filters that produced this selection stay on screen and are
            visibly still in force. A bar that covers its own filters is how
            somebody acts on a set they can no longer see. */}
        {selected.size > 0 && (
          <div className="ua-selbar" role="region" aria-label="Selected people">
            <span className="ua-selbar__n">
              {selected.size} selected
            </span>

            <button type="button" className="ua-tbtn" disabled={bulkBusy}
                    onClick={() => bulkSetStatus("SUSPENDED")}>
              {bulkBusy ? "Working…" : "Suspend"}
            </button>
            <button type="button" className="ua-tbtn" disabled={bulkBusy}
                    onClick={() => bulkSetStatus("ACTIVE")}>
              Reactivate
            </button>
            <button type="button" className="ua-tbtn" disabled={bulkBusy}
                    onClick={bulkResend}>
              Resend invite
            </button>

            <button type="button" className="ua-tbtn" onClick={() => setSelected(new Set())}>
              Clear
            </button>

            {/* Stated, not hidden. Deleting an account here means typing a
                phrase per person on purpose, and a checkbox column is the
                exact opposite of that — so it is absent, and the reason is
                on screen rather than left as a gap somebody has to infer. */}
          </div>
        )}

        {/* The two message slots that used to sit here are gone. Everything
            this page has to say now says it in the toast, which is one place
            rather than two and is in the corner the eye returns to after an
            action rather than at the top of a list somebody has scrolled away
            from. The live region moved with them, onto the toast itself.

            What has NOT moved: both drawers still show a failure against
            their own submit button. A form error belongs beside the form. */}
        {/* ── Add user ───────────────────────────────────────── */}
        <Drawer
          open={inviteOpen}
          onClose={closeInvite}
          id="ua-invite"
          title="New account"
          hint="They choose their own password from an emailed link."
        >
              <form className="ua-form" onSubmit={handleCreate} noValidate>
                <div className="ua-drawer__body">
            <div className="ua-form__row">
              <label className="ua-field">
                <span className="ua-label">Full name</span>
                <input className="ua-input" type="text" value={form.fullName}
                       onChange={set("fullName")} disabled={busy} required />
              </label>

              <label className="ua-field">
                <span className="ua-label">Email</span>
                <input className="ua-input" type="email" autoComplete="off" value={form.email}
                       onChange={set("email")} disabled={busy} required />
              </label>

              <label className="ua-field">
                <span className="ua-label">Phone (optional)</span>
                <input className="ua-input" type="tel" value={form.phone}
                       onChange={set("phone")} disabled={busy} />
              </label>

              <label className="ua-field">
                <span className="ua-label">Employee ID (optional)</span>
                <input className="ua-input" type="text" value={form.employeeId}
                       onChange={set("employeeId")} disabled={busy} />
              </label>
            </div>

            {/* Access: one role, then the organisations it applies in. */}
            <fieldset className="ua-access">
              <legend className="ua-access__legend">
                Access
                <span className="ua-access__hint">
                  {canAssignRoles
                    ? "Choose their role, then each organisation they belong to. The role is the same in all of them."
                    : "Tick each organisation. You cannot assign roles, so they will be granted access with no role."}
                </span>
              </legend>

              {canAssignRoles && (
                <RolePicker roles={createChoices} chosen={createRoles}
                            onChoose={(slug) => setCreateRoles([slug])} disabled={busy} />
              )}
              <OrgPicker
                orgs={orgs}
                draft={picked}
                base={null}
                disabled={busy}
                currentOrgId={orgId}
                onToggleOrg={toggleOrg}
                onSelectAll={(selectAll) => {
                  setPicked((current) => {
                    if (!selectAll) return {};
                    return Object.fromEntries(orgs.map((org) => [org.id, current[org.id] ?? []]));
                  });
                }}
              />
            </fieldset>

                </div>

                {/* The actions ride on the panel's foot rather than at the end
                    of a long scroll, because the organisation list has no
                    bounded height: with twenty sites, a submit button below it
                    is a button nobody can see from where the last field is. */}
                <footer className="ua-drawer__foot">
                  {/* Not a second live region. The pair on the page behind this
                      panel already announces it once; this is the same words
                      put where the person who just pressed Create is looking,
                      and tied to that button so it is read on the way back. */}
                  {error && (
                    <p className="ua-drawer__error" id="ua-invite-error">{error}</p>
                  )}
                  <div className="ua-drawer__acts">
                    <button type="button" className="ua-tbtn" onClick={closeInvite} disabled={busy}>
                      Cancel
                    </button>
                    <button className="ua-submit" type="submit"
                            aria-describedby={error ? "ua-invite-error" : undefined}
                            disabled={busy || !form.fullName.trim() || !form.email.trim() || selectedOrgIds.length === 0}>
                      {busy ? "Creating…" : "Create and invite"}
                    </button>
                  </div>
                </footer>
              </form>
        </Drawer>

        {/* ── Edit one person ────────────────────────────────────────
            Everything about one account in one place: who they are, whether
            they can sign in, and what they can reach. It was three controls in
            three places before — an access strip that opened inside the table,
            a Suspend button on the row, and nowhere at all to correct a
            misspelled name — so "edit this person" was not something this page
            could do, only a set of things it could do to them. */}
        <Drawer
          open={editing !== null}
          onClose={closeEditor}
          id="ua-profile"
          title={editUser?.fullName ?? "Account"}
          hint={editUser ? (editUser.email ?? "No email address") : undefined}
        >
          {editBase === null || !editUser ? (
            <div className="ua-drawer__body">
              <p className="ua-edit__loading">Reading their access…</p>
            </div>
          ) : (
            <form
              className="ua-form"
              noValidate
              onSubmit={(e) => { e.preventDefault(); saveEditor(editUser); }}
            >
              <div className="ua-drawer__body">
                {/* ─ Details ─ */}
                <section className="ua-sect">
                  <h3 className="ua-sect__title">Details</h3>
                  {identityEditable(editUser) ? (
                    <div className="ua-form__row">
                      <label className="ua-field">
                        <span className="ua-label">Full name</span>
                        <input className="ua-input" type="text" value={editForm.fullName}
                               onChange={editField("fullName")} disabled={editBusy} required />
                      </label>
                      <label className="ua-field">
                        <span className="ua-label">Phone</span>
                        <input className="ua-input" type="tel" value={editForm.phone}
                               onChange={editField("phone")} disabled={editBusy} />
                      </label>
                      <label className="ua-field">
                        <span className="ua-label">Employee ID</span>
                        <input className="ua-input" type="text" value={editForm.employeeId}
                               onChange={editField("employeeId")} disabled={editBusy} />
                      </label>
                    </div>
                  ) : (
                    /* Read-only, and told why. The alternative is three fields
                       that look editable and answer 403, or three fields greyed
                       out with nothing on screen to explain it. */
                    <>
                      <dl className="ua-facts">
                        <dt>Full name</dt><dd>{editUser.fullName}</dd>
                        <dt>Phone</dt><dd>{editUser.phone || "-"}</dd>
                        <dt>Employee ID</dt><dd>{editUser.employeeId || "-"}</dd>
                      </dl>
                    </>
                  )}
                </section>

                {/* ─ Account ─ */}
                <section className="ua-sect">
                  <h3 className="ua-sect__title">Account</h3>
                  <div className="ua-acct">
                    {/* The badge shows the DRAFT, not the stored account: the
                        panel has to show what Save would produce, or the row
                        you are about to change and the sentence under it would
                        disagree. */}
                    <StatusBadge state={accountState({ ...editUser, status: editStatus })} />
                    {canIn(editUser.scopeOrgId, "user:update") && (
                      <button type="button"
                              className={"ua-action"
                                + (editStatus !== editUser.status ? " ua-action--armed" : "")}
                              onClick={() => setEditStatus((v) =>
                                (v === "SUSPENDED" ? "ACTIVE" : "SUSPENDED"))}
                              title={editStatus === "ACTIVE"
                                ? "Marks the account to be suspended. It happens when you save, and signs them out everywhere."
                                : "Marks the account to be reactivated. It happens when you save; they sign in with the password they already had."}
                              disabled={editBusy}>
                        {editStatus === "ACTIVE" ? "Suspend" : "Reactivate"}
                      </button>
                    )}
                  </div>

                  {/* Only while it differs from what is stored. A panel that
                      permanently explained what Save does would be furniture;
                      this appears exactly when there is something staged, and
                      names the undo, because the undo for a staged change is
                      the button that produced it. */}
                </section>

                {/* ─ Access ─ */}
                <section className="ua-sect">
                  <h3 className="ua-sect__title">Access</h3>
                  {canAssignRoles && editRolesBase != null && (
                    <>
                      <p className="ua-access__hint">Their role, in every organisation below.</p>
                      <RolePicker roles={rolesByOrg[orgId]} chosen={editRoles} held={editRolesBase}
                                  onChoose={(slug) => setEditRoles([slug])} disabled={editBusy} />
                    </>
                  )}
                  <OrgPicker
                    orgs={orgs}
                    draft={editDraft}
                    base={editBase}
                    disabled={editBusy}
                    currentOrgId={orgId}
                    onToggleOrg={toggleEditOrg}
                  />
                </section>
              </div>

              <footer className="ua-drawer__foot">
                {error && <p className="ua-drawer__error" id="ua-profile-error">{error}</p>}
                <div className="ua-drawer__acts">
                  <button type="button" className="ua-tbtn" onClick={closeEditor} disabled={editBusy}>
                    Cancel
                  </button>
                  <button type="submit" className="ua-submit"
                          aria-describedby={error ? "ua-profile-error" : undefined}
                          disabled={editBusy}>
                    {editBusy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </footer>
            </form>
          )}
        </Drawer>

        {/* A tenant that failed on its own.
            `listUsersAcrossOrgs` catches each roster separately, so one
            organisation timing out costs its own rows and nothing else. That
            is the right behaviour and a silent one: the list simply comes back
            short. Saying which organisation is missing is what stops a partial
            roster being read as a complete one — and it is a warning rather
            than an error, because everything else on screen is real. */}
        {(data?.failures?.length ?? 0) > 0 && (
          <p className="ua-partial" role="status">
            Could not load {data.failures.map((f) => orgNameById.get(f.orgId) ?? "an organisation").join(", ")}.
            These people are not shown.
            {" "}<button type="button" className="ua-action" onClick={retry}>Try again</button>
          </p>
        )}

        {loadError ? (
          <LoadError label="Users" onRetry={retry} fullSection />
        ) : !loading && users.length === 0 ? (
          <TabEmptyState
            icon={<DriversIcon size={44} />}
            title="No accounts yet"
            hint="Nobody has been invited to the dashboard yet. Invite somebody and they will appear here. Drivers synced from the operations registry are not shown, they have no sign-in."
          />
        ) : !loading && shown.length === 0 ? (
          /* NOT the empty state above, and the difference matters: there are
             people here, the filter is simply hiding them. So this says what
             was asked for, and offers the way back — an empty screen with no
             explanation is how a filter gets mistaken for a broken roster. */
          <div className="ua-nomatch" role="status">
            <p className="ua-nomatch__line">
              No {STATUS_TABS.find((t) => t.key === statusKey).noun}
              {needle && <> matching <span className="ua-nomatch__q">{query.trim()}</span></>}
              {roleName !== "any" && <> {roleName === NO_ROLE ? "without a role here" : `holding ${roleName}`}</>}.
            </p>
            <button type="button" className="ua-action" onClick={clearFilters}>Clear filters</button>
          </div>
        ) : view !== "table" ? null : (
          <section className="ua-roster">
            <div className="ua-table-scroll">
              <table className="ua-table">
                <thead>
                  <tr>
                    {/* Select-all covers the PAGE, not the roster. Claiming to
                        have selected 380 rows while fifteen are visible is how
                        somebody suspends an organisation by accident. */}
                    <th className="ua-selcell">
                      <button
                        type="button"
                        className="ua-check"
                        role="checkbox"
                        aria-checked={headState === "all" ? "true" : headState === "some" ? "mixed" : "false"}
                        aria-label={headState === "all" ? "Clear this page" : "Select this page"}
                        onClick={() => setSelected((prev) => toggleAllVisible(prev, visibleIds))}
                      >
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                             stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                          {headState === "some"
                            ? <path d="M3 6h6" strokeLinecap="round" />
                            : <path d="M2 6.4l2.6 2.6L10 3.4" strokeLinecap="round" strokeLinejoin="round" />}
                        </svg>
                      </button>
                    </th>
                    {columns.map((c) => {
                      const on = sort?.key === c.key;
                      return (
                        <th key={c.key} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                          <button type="button" className="ua-sort" onClick={() => clickSort(c.key)}>
                            {c.label}
                            {/* Drawn only on the sorted column. A permanent
                                pair of grey chevrons on every head is six
                                pieces of furniture saying nothing. */}
                            {on && (
                              <span className="ua-sort__dir" aria-hidden="true">
                                {sort.dir === "asc" ? "\u25b2" : "\u25bc"}
                              </span>
                            )}
                          </button>
                        </th>
                      );
                    })}
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((u) => {
                    /* Everything about this row is graded in the row's OWN
                       organisation, not in the one the header is showing. An
                       administrator can hold user:delete in one company and
                       nothing but user:read in another, and the buttons have
                       to say so — a Delete drawn over a row the server will
                       refuse is worse than no Delete at all. */
                    const rowOrg = u.scopeOrgId;
                    const rowOrgIds = u.scopeOrgIds ?? [rowOrg];
                    const rowCan = (slug) => canIn(rowOrg, slug);
                    const key = rowKey(u);
                    const roles = rolesFor(u);
                    const changes = u.passwordChangeCount ?? 0;
                    const state = accountState(u);
                    const open = editing === key;
                    const confirming = deleting === key;
                    const phrase = confirmPhraseFor(u);
                    const match = confirming ? confirmState(confirmText, phrase) : "empty";
                    /* Per row for the same reason: the shortcut belongs to an
                       administrator OF THIS ORGANISATION. */
                    const rowSkipsTyping = skipsTypedConfirmation({ isPlatform, can: rowCan });
                    const armed = rowSkipsTyping || confirmMatches(confirmText, phrase);
                    return (
                      <Fragment key={key}>
                      {/* `data-label` on every cell is what lets the roster
                          become a stack of cards under 768px (UserAdminPanel.scss):
                          with no table head to sit under, each value has to
                          carry the column name it came from. They are inert on
                          a desktop, where the head is still doing that job. */}
                      <tr className={"ua-row" + (open || confirming ? " ua-row--open" : "")}>
                        <td className="ua-selcell">
                          <button
                            type="button"
                            className="ua-check"
                            role="checkbox"
                            aria-checked={selected.has(key)}
                            aria-label={`Select ${u.fullName}`}
                            onClick={() => setSelected((prev) => toggleSelected(prev, key))}
                          >
                            <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                                 stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                              <path d="M2 6.4l2.6 2.6L10 3.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        </td>
                        <td className="ua-row__namecell" data-label="Full name">
                          <span className="ua-who">
                            <Avatar name={u.fullName} email={u.email} />
                            <span className="ua-row__name">{u.fullName}</span>
                          </span>
                        </td>
                        {shows("email") && (
                          /* Masked, then a real mailto once revealed. The
                             address was previously a grey sub-line that looked
                             like a caption and could not be clicked; if it is
                             worth a column it is worth being the thing you use
                             it for -- but forty of them on a control-room
                             display is a staff directory nobody asked to
                             publish. One click, one person. */
                          <td data-label="Email">
                            <Contact value={u.email} kind="email" who={u.fullName}
                                     shown={inClear(u.id, "email")}
                                     onToggle={() => toggleContact(u.id, "email")} />
                          </td>
                        )}
                        {shows("phone") && (
                          <td className="ua-row__num" data-label="Phone">
                            <Contact value={u.phone} kind="phone" who={u.fullName}
                                     shown={inClear(u.id, "phone")}
                                     onToggle={() => toggleContact(u.id, "phone")} />
                          </td>
                        )}
                        {shows("org") && (
                          /* All of them, not the one the row was read from.
                             The row is a person; "which organisations do they
                             belong to" is a fact about them, and it used to be
                             answered by counting how many times their name
                             appeared in the list. */
                          <td data-label="Organisation">
                            <span className="ua-row__orgs">
                              {rowOrgIds.map((id) => (
                                <OrgBadge key={id} id={id} org={orgById.get(id)}
                                          here={id === orgId} />
                              ))}
                            </span>
                          </td>
                        )}
                        {shows("group") && (
                          <td data-label="Group">
                            {u.group
                              ? <span className="ua-groupchip">{displayGroupText(u.group.name)}</span>
                              /* Said, not left blank. An ungrouped account is
                                 reachable by the platform administrator alone
                                 once enforcement is on, and that is a fact
                                 about the row rather than missing data. */
                              : <span className="ua-row__norole">ungrouped</span>}
                          </td>
                        )}
                        {shows("roles") && (
                        <td className="ua-row__rolescell" data-label="Roles">
                          {roles.length === 0 ? (
                            <span className="ua-row__norole">none</span>
                          ) : (
                            <span className="ua-row__roles">
                              {roles.map((name) => (
                                <span className="ua-rolechip" key={name}>{name}</span>
                              ))}
                            </span>
                          )}
                        </td>
                        )}
                        {shows("status") && (
                          <td data-label="Status"><StatusBadge state={state} /></td>
                        )}
                        {shows("created") && (
                          <td className="ua-row__num" data-label="Created">{fmtDate(u.createdAt)}</td>
                        )}
                        {shows("password") && (
                        <td className="ua-row__num" data-label="Password">
                          {changes === 0 ? (
                            /* The one filled badge in the grid, and it is spent
                               here on purpose: an account that has never had a
                               password cannot sign in at all, which is the one
                               row-level fact an administrator has to act on.
                               Distinct from "changed once, long ago". */
                            <span className="ua-never">never set</span>
                          ) : (
                            <>
                              {fmtDate(u.passwordChangedAt)}
                              <span className="ua-row__count">
                                {changes} {changes === 1 ? "change" : "changes"}
                              </span>
                            </>
                          )}
                        </td>
                        )}
                        <td className="ua-row__actionscell" data-label="Actions">
                          <div className="ua-row__actions">
                          {/* Only offered while an invitation is the thing
                              standing between them and the dashboard. The
                              server refuses to re-invite an account that
                              already has a password — that is an account
                              takeover vector — so showing this to everybody
                              would be offering a click that can only fail. */}
                          {state.key !== "active" && (
                            <button type="button" className="ua-action"
                                    onClick={() => handleResend(u)}
                                    disabled={rowBusy === key || !u.email}>
                              Resend invite
                            </button>
                          )}
                          {/* "Edit access" was the honest name while that was
                              all it did. It opens the whole person now — their
                              details, their access, and whether the account is
                              suspended — so it is Edit.

                              Suspend/Reactivate went in there with it. It used
                              to be its own row button, which made the row the
                              place you change one fact about somebody and the
                              panel the place you change another, with no rule
                              telling you which was which. */}
                          {(rowCan("user:assign_role") || rowCan("user:update")) && (
                            <button type="button" className="ua-action"
                                    onClick={() => openEditor(u)}
                                    aria-haspopup="dialog"
                                    aria-expanded={open}
                                    disabled={editBusy}>
                              Edit
                            </button>
                          )}
                          {/* Never offered for the account doing the looking.
                              The server refuses it anyway, but a control whose
                              only outcome is an error message is a control
                              that should not be drawn. */}
                          {/* Not on a merged row. Delete is per organisation
                              on the server — it removes the account row and
                              its grants — and a button sitting on a person who
                              belongs to three of them cannot say which one it
                              means. Narrow the scope picker to one
                              organisation and it comes back, addressed to
                              something the operator chose. */}
                          {rowCan("user:delete") && u.id !== me?.id && rowOrgIds.length === 1 && (
                            <button type="button" className="ua-action ua-action--danger"
                                    onClick={() => openDelete(u)}
                                    aria-expanded={confirming}
                                    disabled={deleteBusy}>
                              {confirming ? "Keep" : "Delete"}
                            </button>
                          )}
                          </div>
                        </td>
                      </tr>

                      {/* The confirmation, in the flow of the table like the
                          editor above it — and deliberately NOT sharing its
                          shape. This one is red-ruled, narrow, and has one
                          field in it, because the difference between "change
                          what they can reach" and "destroy them" should be
                          visible before anything is read. */}
                      {confirming && (
                        <tr className="ua-editrow ua-editrow--danger">
                          <td colSpan={columns.length + 2}>
                            <div className="ua-danger">
                              <div className="ua-danger__head">
                                <span className="ua-danger__title">
                                  Permanently delete {u.fullName}
                                </span>
                                <span className="ua-danger__hint">
                                  The account row is removed from storage along with its role
                                  grants, sign-in sessions and invitations. It is not marked
                                  deleted, there is nothing left to restore, and the same
                                  address can be invited again as a new person.
                                  {" "}Suspending keeps the account and ends every session.
                                </span>
                              </div>

                              {rowSkipsTyping ? (
                                /* Nothing to type, so nothing that looks like a
                                   form. A disabled-looking field with no job
                                   would read as a step somebody forgot to
                                   remove. What replaces it is the sentence that
                                   makes the live button legible: it is live
                                   BECAUSE of who you are, which is not
                                   otherwise visible anywhere on this row. */
                                <p className="ua-danger__armed">
                                  You are an administrator here, so this does not ask you to type
                                  the address. The next click deletes {u.fullName}.
                                </p>
                              ) : (
                              <div className="ua-danger__confirm">
                              {/* `ua-field` is what DRAWS a field on this page.
                                  `ua-input` is deliberately chrome-less —
                                  transparent, no border, no padding — and takes
                                  its box from the wrapper, exactly as every
                                  field in the invite form above does. Without
                                  the wrapper this rendered as invisible text on
                                  the card: nothing to aim at, nothing to type
                                  into, and a button that could never arm. */}
                              <label className={"ua-field ua-danger__field ua-danger__field--" + match}>
                                <span className="ua-label">
                                  Type <code className="ua-danger__phrase">{phrase}</code> to confirm
                                </span>
                                <input
                                  className="ua-input"
                                  type="text"
                                  autoComplete="off"
                                  spellCheck="false"
                                  autoCapitalize="none"
                                  autoCorrect="off"
                                  value={confirmText}
                                  onChange={(e) => setConfirmText(e.target.value)}
                                  disabled={deleteBusy}
                                  aria-describedby={`${u.id}-confirm-state`}
                                  aria-label={`Type ${phrase} to confirm deletion`}
                                />
                                {/* Why the button below is dead, said on the
                                    field that controls it. Three states, and
                                    the middle one earns its place: "keep
                                    going" is not the same message as "wrong",
                                    and a disabled button beside a filled-in
                                    box with neither of them on screen is what
                                    made this control read as broken. */}
                              </label>
                                <span className="ua-danger__state" id={`${u.id}-confirm-state`} role="status">
                                  {match === "match"
                                    ? "Matches, the button below is live."
                                    : match === "partial"
                                      ? "Not the whole address yet. Capitals do not matter."
                                      : "The button below stays disabled until this matches."}
                                </span>
                              </div>
                              )}

                              <div className="ua-edit__foot">
                                <button type="button" className="ua-submit ua-submit--inline ua-submit--danger"
                                        onClick={() => handleDelete(u)}
                                        disabled={deleteBusy || !armed}>
                                  {deleteBusy ? "Deleting…" : "Delete permanently"}
                                </button>
                                <button type="button" className="ua-action"
                                        onClick={() => { setDeleting(null); setConfirmText(""); }}
                                        disabled={deleteBusy}>
                                  Keep the account
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Pager ────────────────────────────────────────────────────
                The app's one pager (TablePager, operator 2026-10-12: "the
                pagination should be consistent across all pages"), fifteen
                to a page, drawn only when there is a second page. It counts
                pages from 0, the roster from 1. */}
            <TablePager
              label="Roster pages"
              pager={{
                page: paged.page - 1,
                pageCount: paged.pageCount,
                total: paged.total,
                from: paged.from,
                to: paged.to,
                setPage: (n) => setPage(n + 1),
              }}
            />
          </section>
        )}

        {/* ── Board ──────────────────────────────────────────────────────────
            Grouped by whether the person can actually sign in, which is the
            one axis worth grouping a roster on. Role would make tidier columns
            and answer nothing; "who is stuck" is the question this page exists
            for, and the board is the only view that answers it at a glance.

            Not paged, deliberately: paging a board would hide part of a column
            and quietly understate exactly the group somebody came to find. */}
        {!loadError && !loading && shown.length > 0 && view === "board" && (
          <>
            {/* Said out loud, because a drag affordance is invisible until
                somebody tries it, and nobody tries it on a page of records.
                The sentence also carries the keyboard route, which is not a
                footnote: dragging is a pointer gesture and this has to be
                doable without one.

                Outside the board rather than inside it: .ua-board is a grid,
                and a paragraph in it is a grid ITEM -- spanning it 1 / -1
                collapsed every column to 14px. */}
            <p className="ua-board__hint">
              Drag a card between Active and Suspended to change an account.
              {" "}Manage does the same from the keyboard.
            </p>
          <div className="ua-board">
            {STATUS_TABS.filter((t) => t.key !== "all").map((tab) => {
              const group = sorted.filter((u) => accountState(u).key === tab.key);
              const takes = dropCol === tab.key;
              return (
                <section
                  className={"ua-board__col"
                    + (takes ? " ua-board__col--takes" : "")}
                  key={tab.key}
                  /* preventDefault is what MAKES a box a drop target in the
                     HTML drag model — withholding it on the derived columns is
                     how Pending refuses a card rather than accepting one and
                     doing nothing with it. */
                  onDragOver={(e) => {
                    if (!dropTarget(tab.key)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropCol !== tab.key) setDropCol(tab.key);
                  }}
                  onDragLeave={(e) => {
                    // Ignore the crossings between this column's own children.
                    if (e.currentTarget.contains(e.relatedTarget)) return;
                    setDropCol((c) => (c === tab.key ? null : c));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const u = dragRef.current;
                    const ok = dropTarget(tab.key);
                    endDrag();
                    if (u && ok) {
                      handleStatus(u, tab.key === "suspended" ? "SUSPENDED" : "ACTIVE");
                    }
                  }}
                >
                  <header className="ua-board__head">
                    <span className="ua-state__dot" aria-hidden="true"
                          style={{ color: `var(--ua-${tab.key === "active" ? "ok"
                            : tab.key === "pending" ? "info"
                            : tab.key === "suspended" ? "warn" : "crit"})` }} />
                    <span className="ua-board__title">{tab.label}</span>
                    <span className="ua-board__n">{group.length}</span>
                  </header>

                  {group.length === 0 ? (
                    <p className="ua-board__empty">Nobody</p>
                  ) : group.map((u) => (
                    <article
                      className={"ua-bcard"
                        + (canDrag(u) ? " ua-bcard--drag" : "")
                        + (dragKey === rowKey(u) ? " ua-bcard--lifted" : "")}
                      key={rowKey(u)}
                      draggable={canDrag(u)}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        /* Firefox starts no drag at all without a payload.
                           The name, because if a card is ever dropped outside
                           this board the thing that receives it should get
                           something a person wrote, not an internal key. */
                        e.dataTransfer.setData("text/plain", u.fullName);
                        dragRef.current = u;
                        setDragKey(rowKey(u));
                      }}
                      onDragEnd={endDrag}>
                      <span className="ua-who">
                        <Avatar name={u.fullName} email={u.email} />
                        <span className="ua-who__text">
                          <span className="ua-row__name">{u.fullName}</span>
                          <span className="ua-row__email">{(inClear(u.id, "email") ? u.email : maskEmail(u.email)) || "no email"}</span>
                        </span>
                      </span>
                      {rolesFor(u).length > 0 && (
                        <span className="ua-row__roles">
                          {rolesFor(u).map((name) => (
                            <span className="ua-rolechip" key={name}>{name}</span>
                          ))}
                        </span>
                      )}
                      {/* Organisations, always — not behind `showOrgColumn`,
                          which is the TABLE's question ("is that column worth
                          its width") asked on a view that has no columns. A
                          card is one person, and which organisations they
                          belong to is part of who they are here; on the board
                          it is also the only place that fact appears, since
                          there is no column chooser to turn back on.

                          Above the foot rather than in it: the foot is the
                          card's action strip, and a fact wrapped in beside a
                          button reads as a label for the button. */}
                      <span className="ua-row__orgs ua-bcard__orgs">
                        {(u.scopeOrgIds ?? [u.scopeOrgId]).filter(Boolean).map((id) => (
                          <OrgBadge key={id} id={id} org={orgById.get(id)} here={id === orgId} />
                        ))}
                      </span>

                      <div className="ua-bcard__foot">
                        {(canIn(u.scopeOrgId, "user:assign_role") || canIn(u.scopeOrgId, "user:update")) && (
                          <button type="button" className="ua-action" onClick={() => jumpTo(u)}>
                            Manage
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </section>
              );
            })}
          </div>
          </>
        )}

        {/* ── List ───────────────────────────────────────────────────────────
            One line per person, no columns. It is the view that survives a
            phone and a narrow split pane, where the grid has to scroll
            sideways and the board has to stack four times over. */}
        {!loadError && !loading && shown.length > 0 && view === "list" && (
          <div className="ua-list">
            {sorted.map((u) => (
              <div className="ua-litem" key={rowKey(u)}>
                <Avatar name={u.fullName} email={u.email} />
                <span className="ua-who__text">
                  <span className="ua-row__name">{u.fullName}</span>
                  <span className="ua-row__email">{(inClear(u.id, "email") ? u.email : maskEmail(u.email)) || "no email"}</span>
                </span>
                {/* Between the person and their state, which is the order the
                    row already reads in: who, where, how they stand. Allowed
                    to shrink and wrap rather than push the status badge off
                    the end — this is the view that has to survive a phone. */}
                <span className="ua-row__orgs ua-litem__orgs">
                  {(u.scopeOrgIds ?? [u.scopeOrgId]).filter(Boolean).map((id) => (
                    <OrgBadge key={id} id={id} org={orgById.get(id)} here={id === orgId} />
                  ))}
                </span>
                <span className="ua-litem__meta">
                  <StatusBadge state={accountState(u)} />
                  {(canIn(u.scopeOrgId, "user:assign_role") || canIn(u.scopeOrgId, "user:update")) && (
                    <button type="button" className="ua-action" onClick={() => jumpTo(u)}>
                      Manage
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Undo ────────────────────────────────────────────────────────────
          The reason the bulk status actions need no confirmation in FRONT of
          them. An optimistic change plus a way back beats a dialog asking
          whether you meant the thing you just clicked — and this is the only
          place on the page that changes several accounts at once without a
          typed phrase. */}
      {toast && (
        /* alert for a failure, status for everything else: an error has to
           interrupt a screen reader rather than wait its turn behind whatever
           is being read, and an outcome must not. */
        <div className={`ua-toast ua-toast--${toast.tone ?? "ok"}`}
             role={toast.tone === "error" ? "alert" : "status"}
             aria-live={toast.tone === "error" ? "assertive" : "polite"}>
          <ToastMark tone={toast.tone ?? "ok"} />
          <span className="ua-toast__text">{toast.text}</span>
          {/* Only when there is one. A disabled or absent-action "Undo" on a
              permanent deletion would be the cruellest button on the page. */}
          {toast.undo && (
            <button type="button" className="ua-toast__undo" onClick={toast.undo}>Undo</button>
          )}
          <button type="button" className="ua-toast__x" aria-label="Dismiss"
                  onClick={() => setToast(null)}>
            {"\u2715"}
          </button>
        </div>
      )}
    </div>
  );
}
