/**
 * User groups for one organisation.
 *
 * Built from UserAdminPanel's own parts so the two pages are one product: the
 * same Modal for create/edit/delete, the same status badge (dot inside a
 * tinted pill), the same name-derived avatar hue, the same toast, the same
 * OrgMark. Companies are never a bare string here: the tile, the card row and
 * the switcher all draw the tenant's mark beside its name.
 *
 * A group spans 1 to ALL of the organisations the admin can reach, so the
 * people in it can belong to different organisations, or to the same one. The
 * page's scope (which organisations are listed) and each group's own
 * organisations (chosen in the modal) are both multi-select with logos.
 *
 * Adding people happens ON the card. Each group carries a search-as-you-type
 * picker (name or email); a row reads "Add" or "Remove" depending on whether
 * the person is already in, so one control does both jobs and the page has no
 * members table at all.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listUsersAcrossOrgs } from "../../api/users";
import {
  addUserToGroup, createUserGroup, deleteUserGroup, listUserGroups,
  removeUserFromGroup, updateUserGroup,
} from "../../api/userGroups";
import { useAuth } from "../../context/AuthContext";
import { usePermissions } from "../../hooks/usePermissions";
import { useApiData } from "../../hooks/useApiData";
import { displayGroupText } from "../../lib/groupDisplay";
import { companyMark } from "../../lib/companyLogos";
import LoadError from "../shared/LoadError";
import TabEmptyState from "../shared/TabEmptyState";
import { DriversIcon } from "../footer/NavIcons";
import "./UserGroupsPanel.css";

const EMPTY_GROUP = { name: "", description: "" };

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
];

const SORTS = [
  { key: "recent", label: "Most Recent" },
  { key: "name", label: "Name (A–Z)" },
  { key: "members", label: "Most Members" },
];

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const isMember = (user, groupId) => !!user.groups?.some((g) => g.id === groupId);

function initialsOf(name, email) {
  const source = String(name ?? "").trim() || String(email ?? "").trim();
  if (!source) return "\u00b7";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/** Stable per person, so the disc keeps its colour across sorts and pages. */
function hueOf(text) {
  const source = String(text ?? "");
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) % 360;
  return h;
}

function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* ── Small parts ─────────────────────────────────────────────────────────── */

function Icon({ name }) {
  const paths = {
    group: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19M16 5.5a3 3 0 0 1 0 5.8M17 13h.5a3.5 3.5 0 0 1 3 3.5V19" /></>,
    userPlus: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19v-1a4.5 4.5 0 0 1 4.5-4.5h2A4.5 4.5 0 0 1 14.5 18v1M18 8v6M15 11h6" /></>,
    roster: <><circle cx="9" cy="9" r="2.6" /><path d="M4.5 18a4.5 4.5 0 0 1 9 0M16 8h4M16 12h4M16 16h4" /></>,
    ungrouped: <><circle cx="12" cy="9" r="3" /><path d="M6 19a6 6 0 0 1 12 0" strokeDasharray="2 2.4" /></>,
    building: <path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V20M15 9h2.5A1.5 1.5 0 0 1 19 10.5V20M3 20h18M8.5 8h3M8.5 12h3M8.5 16h3" />,
    clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4.2l2.6 1.6" /></>,
    people: <><circle cx="12" cy="8.5" r="3" /><path d="M6 19a6 6 0 0 1 12 0" /></>,
    user: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="10" r="2.6" /><path d="M6.8 18a5.8 5.8 0 0 1 10.4 0" /></>,
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.8-3.8" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  };
  return (
    <svg className="ug-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">{paths[name]}</svg>
  );
}

function Avatar({ name, email, size = 22 }) {
  return (
    <span className="ug-avatar" aria-hidden="true"
          style={{ "--ug-avatar-h": hueOf(name || email), width: size, height: size }}>
      {initialsOf(name, email)}
    </span>
  );
}

/** One organisation's mark; a letter on a hue when no artwork is on file. */
function OrgMark({ org, size = 16 }) {
  const name = org?.name ?? "-";
  const mark = org ? companyMark(org) : null;
  if (mark) {
    return <img className="ug-orgmark" style={{ width: size, height: size }} src={mark} alt="" />;
  }
  return (
    <span className="ug-orgmark ug-orgmark--letter" aria-hidden="true"
          style={{ width: size, height: size, fontSize: Math.round(size * 0.56), "--ug-avatar-h": hueOf(name) }}>
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/** The company, with its logo. The name stays: a mark alone is a logo quiz. */
function OrgBadge({ org, here }) {
  const name = org?.name ?? "-";
  return (
    <span className={"ug-orgbadge" + (here ? " ug-orgbadge--here" : "")} title={name}>
      <OrgMark org={org} />
      <span className="ug-orgbadge__name">{name}</span>
    </span>
  );
}

/** Overlapping marks for several organisations, "+N" past `max`. */
function OrgStack({ orgs, max = 3, size = 18 }) {
  const shown = orgs.slice(0, max);
  const more = orgs.length - shown.length;
  return (
    <span className="ug-orgstack" title={orgs.map((o) => o.name).join(", ")}>
      {shown.map((o) => <OrgMark key={o.id} org={o} size={size} />)}
      {more > 0 && <span className="ug-orgstack__more">+{more}</span>}
    </span>
  );
}

/** What a set of organisations is called: its name, "All organisations", or a count. */
function scopeLabel(orgs, total) {
  if (orgs.length === 1) return orgs[0].name;
  if (orgs.length > 1 && orgs.length === total) return "All organisations";
  return `${orgs.length} organisations`;
}

/** Pick 1 to all organisations, each with its logo. */
function OrgChecklist({ orgs, value, onChange, disabled }) {
  const [find, setFind] = useState("");
  const needle = find.trim().toLowerCase();
  const rows = needle ? orgs.filter((o) => o.name.toLowerCase().includes(needle)) : orgs;
  const all = orgs.length > 0 && orgs.every((o) => value.includes(o.id));

  const toggle = (id) => {
    if (!value.includes(id)) onChange([...value, id]);
    else if (value.length > 1) onChange(value.filter((v) => v !== id));
  };

  return (
    <div className="ug-checklist">
      <div className="ug-checklist__head">
        <span className="ug-checklist__count">{value.length} of {orgs.length} selected</span>
        <button type="button" className="ug-action" disabled={disabled}
                onClick={() => onChange(all ? orgs.slice(0, 1).map((o) => o.id) : orgs.map((o) => o.id))}>
          {all ? "Select one" : "Select all"}
        </button>
      </div>
      {orgs.length > 8 && (
        <input className="ug-checklist__find" type="search" value={find} placeholder="Find an organisation"
               aria-label="Find an organisation" onChange={(e) => setFind(e.target.value)} />
      )}
      <ul className="ug-checklist__list">
        {rows.length === 0 && <li className="ug-picker__empty">Nothing matches {find.trim()}.</li>}
        {rows.map((o) => {
          const on = value.includes(o.id);
          return (
            <li key={o.id}>
              <button type="button" role="checkbox" aria-checked={on} disabled={disabled}
                      className={"ug-check" + (on ? " ug-check--on" : "")} onClick={() => toggle(o.id)}>
                <span className="ug-box" aria-hidden="true" />
                <OrgMark org={o} size={18} />
                <span className="ug-check__name">{o.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Dot inside a tinted, bordered pill, as in the Users Status column. */
function StatusBadge({ active }) {
  return (
    <span className={"ug-badge " + (active ? "ug-badge--active" : "ug-badge--inactive")}>
      <span className="ug-dot" aria-hidden="true" />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function ToastMark({ tone }) {
  const paths = {
    created: <><path d="M8 4.4v7.2" /><path d="M4.4 8h7.2" /></>,
    ok: <path d="M4.6 8.3l2.4 2.4 4.4-5" />,
    deleted: <><path d="M5.5 5.5l5 5" /><path d="M10.5 5.5l-5 5" /></>,
    error: <><path d="M8 4.8v3.9" /><path d="M8 11.2h.01" /></>,
  };
  return (
    <span className="ug-toast__mark" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6.6" />
        {paths[tone] ?? paths.error}
      </svg>
    </span>
  );
}

function Kebab({ label, open, onToggle, disabled, children }) {
  return (
    <span className="ug-menu">
      <button type="button" className="ug-kebab" aria-label={label}
              aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={onToggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open && <span className="ug-menu__pop ug-menu__pop--narrow" role="menu">{children}</span>}
    </span>
  );
}

/**
 * Centred modal dialog over a scrim. Portalled to <body> because a fixed layer
 * is re-anchored by any transformed ancestor; Escape is captured so it does
 * not also leave the screen, and Tab is trapped inside.
 */
function Modal({ open, onClose, id, title, hint, children }) {
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef(null);
  const openerRef = useRef(null);

  useEffect(() => {
    if (open) { setMounted(true); return undefined; }
    if (!mounted) return undefined;
    const t = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(t);
  }, [open, mounted]);

  useEffect(() => {
    if (!open || !mounted) return undefined;
    openerRef.current = document.activeElement;
    panelRef.current?.querySelector(FOCUSABLE)?.focus();
    return () => {
      const back = openerRef.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      const stops = root?.querySelectorAll(FOCUSABLE);
      if (!stops || stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className={"ug-modal-layer" + (open ? "" : " ug-modal-layer--out")}>
      <div className="ug-modal__scrim" onClick={onClose} aria-hidden="true" />
      <aside className="ug-modal" id={id} ref={panelRef} role="dialog"
             aria-modal="true" aria-labelledby={`${id}-title`}>
        <header className="ug-modal__head">
          <span className="ug-modal__heading">
            <h2 className="ug-modal__title" id={`${id}-title`}>{title}</h2>
            {hint && <span className="ug-modal__hint">{hint}</span>}
          </span>
          <button type="button" className="ug-modal__close" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                 strokeWidth="1.8" aria-hidden="true">
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

/** Search by name or email; one row per person, "Add" or "Remove". */
function MemberPicker({ group, users, orgById, manageableOrgIds, pendingKey, onToggle }) {
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  const groupOrgIds = useMemo(() => new Set(group.organisationIds ?? []), [group.organisationIds]);
  const manageable = useMemo(() => new Set(manageableOrgIds), [manageableOrgIds]);
  const eligibleUsers = useMemo(() => users.filter((u) => (u.scopeOrgIds ?? [u.scopeOrgId])
    .some((id) => groupOrgIds.has(id) && manageable.has(id))),
  [users, groupOrgIds, manageable]);
  const roles = useMemo(() => {
    const names = new Set();
    eligibleUsers.forEach((user) => (user.userRoles ?? []).forEach(({ role }) => {
      if (role?.name && groupOrgIds.has(role.organisationId) && manageable.has(role.organisationId)) {
        names.add(role.name);
      }
    }));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [eligibleUsers, groupOrgIds, manageable]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return eligibleUsers
      .filter((u) => !needle || `${u.fullName} ${u.email ?? ""}`.toLowerCase().includes(needle))
      .filter((u) => !roleFilter || (u.userRoles ?? []).some(({ role }) =>
        role?.name === roleFilter && groupOrgIds.has(role.organisationId) && manageable.has(role.organisationId)))
      // People still to add come first; people already in sink to the bottom.
      .sort((a, b) => Number(isMember(a, group.id)) - Number(isMember(b, group.id)))
      .slice(0, 50);
  }, [eligibleUsers, query, roleFilter, group.id, groupOrgIds, manageable]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  useEffect(() => { setActive(0); }, [query, roleFilter]);

  function onKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault(); setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && results[active]) {
      e.preventDefault(); onToggle(results[active]);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); setOpen(false);
    }
  }

  return (
    <div className="ug-picker" ref={rootRef}>
      <div className="ug-picker__controls">
        <label className="ug-picker__search">
          <span className="ug-picker__search-label">Find a user</span>
          <span className="ug-picker__field">
            <Icon name="search" />
            <input type="text" role="combobox" aria-expanded={open} aria-controls={listId}
                   aria-autocomplete="list" autoComplete="off"
                   aria-activedescendant={open && results[active] ? `${listId}-${results[active].id}` : undefined}
                   aria-label={`Add a user to ${displayGroupText(group.name)}`}
                   placeholder="Add user by name or email"
                   value={query}
                   onFocus={() => setOpen(true)}
                   onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                   onKeyDown={onKeyDown} />
          </span>
        </label>
        <label className="ug-picker__role">
          <span className="ug-picker__role-label">Filter by role</span>
          <span className="ug-select">
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
                    onClick={() => setOpen(true)}
                    aria-label="Filter users by role">
              <option value="">All roles</option>
              {roles.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <Icon name="chevron" />
          </span>
        </label>
      </div>
      {open && (
        <ul ref={listRef} className="ug-picker__list" id={listId} role="listbox">
          {results.length === 0 && <li className="ug-picker__empty">No users found</li>}
          {results.map((user, index) => {
            const member = isMember(user, group.id);
            const userOrgs = (user.scopeOrgIds ?? [user.scopeOrgId]).map((id) => orgById.get(id)).filter(Boolean);
            return (
              <li key={user.id} id={`${listId}-${user.id}`} role="option" aria-selected={member}
                  className={"ug-option" + (index === active ? " ug-option--active" : "")}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onToggle(user)}>
                <Avatar name={user.fullName} email={user.email} size={28} />
                <span className="ug-option__info">
                  <strong>{user.fullName}</strong>
                  <small>{user.email || "No email address"}</small>
                </span>
                {userOrgs.length > 0 && <OrgStack orgs={userOrgs} max={2} size={16} />}
                <span className={"ug-option__action" + (member ? " ug-option__action--member" : "")}>
                  {pendingKey === `${group.id}:${user.id}` ? "…" : member ? "Remove" : "Add"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── Panel ───────────────────────────────────────────────────────────────── */

export default function UserGroupsPanel() {
  const { orgs } = useAuth();
  const { orgId, canIn } = usePermissions();

  const adminOrgs = useMemo(
    () => (orgs ?? []).filter((o) => canIn(o.id, "user:read")),
    [orgs, canIn],
  );
  // Only organisations where this admin may actually assign people to groups.
  const manageOrgs = useMemo(
    () => adminOrgs.filter((o) => canIn(o.id, "user:assign_role")),
    [adminOrgs, canIn],
  );
  const orgById = useMemo(() => new Map((orgs ?? []).map((o) => [o.id, o])), [orgs]);

  /* Which organisations the page lists: start with every reachable org. */
  const [scopeIds, setScopeIds] = useState([]);
  const [modal, setModal] = useState(null);      // { mode: "create"|"edit"|"delete", group? }
  const [modalOpen, setModalOpen] = useState(false);
  const [groupForm, setGroupForm] = useState(EMPTY_GROUP);
  const [modalOrgIds, setModalOrgIds] = useState([]);
  const [tab, setTab] = useState("active");
  const [sort, setSort] = useState("recent");
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState(null);
  const searchRef = useRef(null);

  /* Keep the scope on organisations that exist and are reachable, never empty. */
  useEffect(() => {
    if (adminOrgs.length === 0) return;
    if (scopeIds.length === 0) {
      setScopeIds(adminOrgs.map((o) => o.id));
      return;
    }
    const valid = scopeIds.filter((id) => adminOrgs.some((o) => o.id === id));
    if (valid.length === scopeIds.length && valid.length > 0) return;
    setScopeIds(valid.length > 0
      ? valid
      : [adminOrgs.some((o) => o.id === orgId) ? orgId : adminOrgs[0].id]);
  }, [scopeIds, adminOrgs, orgId]);

  const scopeKey = useMemo(() => [...scopeIds].sort().join(","), [scopeIds]);
  const scopeOrgs = useMemo(
    () => scopeIds.map((id) => orgById.get(id)).filter(Boolean),
    [scopeIds, orgById],
  );
  const allInScope = adminOrgs.length > 0 && adminOrgs.every((o) => scopeIds.includes(o.id));

  const toggleScope = useCallback((id) => {
    setScopeIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return next.length === 0 ? cur : next;   // at least one organisation
    });
  }, []);

  const toggleAllScope = useCallback(() => {
    setScopeIds(allInScope
      ? [adminOrgs.some((o) => o.id === orgId) ? orgId : adminOrgs[0].id]
      : adminOrgs.map((o) => o.id));
  }, [allInScope, adminOrgs, orgId]);

  /* Groups come per organisation and are merged by id: a group that spans three
     organisations is one card carrying all three, not three cards. */
  const { data, loading, error: loadError, retry, revalidate, mutate } = useApiData(
    async () => {
      if (scopeIds.length === 0) return { groups: [], users: [], failures: [] };
      const [perOrg, roster] = await Promise.all([
        Promise.all(scopeIds.map(async (id) => {
          try { return { id, groups: await listUserGroups(id) }; }
          catch { return { id, groups: null }; }
        })),
        listUsersAcrossOrgs(scopeIds),
      ]);
      const failures = perOrg.filter((r) => r.groups === null).map((r) => r.id);
      if (failures.length === scopeIds.length) throw new Error("Could not load groups.");
      const byId = new Map();
      for (const { id, groups } of perOrg) {
        for (const g of groups ?? []) {
          const prev = byId.get(g.id);
          const declared = g.organisationIds ?? g.organisations?.map((o) => o.id) ?? [];
          const ids = new Set([...(prev?.organisationIds ?? []), ...declared, id]);
          byId.set(g.id, { ...(prev ?? g), organisationIds: [...ids] });
        }
      }
      return { groups: [...byId.values()], users: roster.users, failures };
    },
    [scopeKey],
    { cacheKey: `ft-org-groups:${scopeKey}` },
  );

  const groups = useMemo(() => data?.groups ?? [], [data]);
  const users = useMemo(() => data?.users ?? [], [data]);

  /* The organisation a write is addressed to: the first of the group's own
     organisations where this admin holds user:assign_role. None = read-only. */
  const homeOrgFor = useCallback(
    (g) => (g.organisationIds ?? []).find((id) => canIn(id, "user:assign_role")) ?? null,
    [canIn],
  );
  const orgsOf = useCallback(
    (g) => (g.organisationIds ?? []).map((id) => orgById.get(id)).filter(Boolean),
    [orgById],
  );

  /* Outcomes are events and expire; failures are states and stay. */
  const say = useCallback((text, tone = "ok") => { setError(""); setToast({ text, tone }); }, []);
  const fail = useCallback((text) => { setError(text); setToast({ text, tone: "error" }); }, []);

  useEffect(() => {
    if (!toast || toast.tone === "error") return undefined;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!menuId) return undefined;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setMenuId(""); } };
    const onDown = (e) => { if (!e.target.closest?.(".ug-menu")) setMenuId(""); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menuId]);

  const membersByGroup = useMemo(() => {
    const map = new Map();
    users.forEach((u) => u.groups?.forEach((g) => {
      if (!map.has(g.id)) map.set(g.id, []);
      map.get(g.id).push(u);
    }));
    return map;
  }, [users]);

  const countFor = useCallback(
    (g) => g._count?.users ?? membersByGroup.get(g.id)?.length ?? 0,
    [membersByGroup],
  );

  const needle = query.trim().toLowerCase();
  const searched = useMemo(
    () => groups.filter((g) => !needle
      || `${g.name} ${g.description ?? ""}`.toLowerCase().includes(needle)),
    [groups, needle],
  );

  const counts = useMemo(() => {
    const tally = { all: searched.length, active: 0, inactive: 0 };
    searched.forEach((g) => { tally[countFor(g) > 0 ? "active" : "inactive"] += 1; });
    return tally;
  }, [searched, countFor]);

  const roll = useMemo(() => {
    const active = groups.filter((g) => countFor(g) > 0).length;
    return { all: groups.length, active, inactive: groups.length - active };
  }, [groups, countFor]);

  const shown = useMemo(() => {
    const rows = searched.filter((g) => {
      if (tab === "active") return countFor(g) > 0;
      if (tab === "inactive") return countFor(g) === 0;
      return true;
    });
    if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "members") rows.sort((a, b) => countFor(b) - countFor(a));
    else rows.sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    return rows;
  }, [searched, tab, sort, countFor]);

  const filtering = needle !== "" || tab !== "all";
  const ungrouped = useMemo(() => users.filter((u) => !u.groups?.length).length, [users]);
  const canCreate = manageOrgs.length > 0;

  const clearFilters = useCallback(() => {
    setQuery(""); setTab("all"); searchRef.current?.focus();
  }, []);

  /* ── Modal ── */
  function openModal(mode, group = null) {
    const manageIds = new Set(manageOrgs.map((o) => o.id));
    const start = group
      ? (group.organisationIds ?? []).filter((id) => manageIds.has(id))
      : scopeIds.filter((id) => manageIds.has(id));
    setGroupForm(group ? {
      name: displayGroupText(group.name),
      description: displayGroupText(group.description ?? ""),
    } : EMPTY_GROUP);
    setModalOrgIds(start.length > 0 ? start : manageOrgs.slice(0, 1).map((o) => o.id));
    setModal({ mode, group });
    setModalOpen(true);
    setMenuId("");
    setError("");
  }
  const closeModal = useCallback(() => { if (!busy) setModalOpen(false); }, [busy]);

  async function saveGroup(e) {
    e.preventDefault();
    if (busy || modalOrgIds.length === 0) return;
    setBusy(true); setError("");
    try {
      /* Organisations the admin cannot manage stay on the group untouched. */
      const manageIds = new Set(manageOrgs.map((o) => o.id));
      const kept = (modal.group?.organisationIds ?? []).filter((id) => !manageIds.has(id));
      const payload = {
        name: displayGroupText(groupForm.name),
        description: displayGroupText(groupForm.description),
        organisationIds: [...modalOrgIds, ...kept],
      };

      if (modal.mode === "edit") {
        const saved = await updateUserGroup(homeOrgFor(modal.group) ?? modalOrgIds[0], modal.group.id, payload);
        mutate((prev) => (prev ? {
          ...prev,
          groups: prev.groups.map((g) => (g.id === modal.group.id
            ? { ...g, ...saved, organisationIds: payload.organisationIds } : g)),
        } : prev));
        say(`${displayGroupText(saved?.name ?? groupForm.name)} updated.`);
      } else {
        const created = await createUserGroup(modalOrgIds[0], payload);
        mutate((prev) => (prev ? {
          ...prev, groups: [{ ...created, organisationIds: payload.organisationIds }, ...prev.groups],
        } : prev));
        say(`${displayGroupText(created?.name ?? groupForm.name)} created across ${plural(payload.organisationIds.length, "organisation")}.`, "created");
      }
      setModalOpen(false);
      revalidate();
    } catch (err) {
      fail(err.message || "Could not save this group.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const group = modal?.group;
    const home = group && homeOrgFor(group);
    if (!home || busy) return;
    setBusy(true); setError("");
    try {
      await deleteUserGroup(home, group.id);
      mutate((prev) => (prev ? {
        ...prev,
        groups: prev.groups.filter((g) => g.id !== group.id),
        users: prev.users.map((u) => ({
          ...u, groups: (u.groups ?? []).filter((g) => g.id !== group.id),
        })),
      } : prev));
      say(`${displayGroupText(group.name)} has been deleted. User accounts were not touched.`, "deleted");
      setModalOpen(false);
      revalidate();
    } catch (err) {
      fail(err.message || "Could not delete this group.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleMembership(group, user) {
    const userOrgIds = user.scopeOrgIds ?? [user.scopeOrgId];
    const orgId = (group.organisationIds ?? []).find((id) =>
      userOrgIds.includes(id) && canIn(id, "user:assign_role"));
    if (!orgId || pendingKey) return;
    const adding = !isMember(user, group.id);
    setPendingKey(`${group.id}:${user.id}`);
    setError("");
    try {
      if (adding) await addUserToGroup(orgId, group.id, user.id);
      else await removeUserFromGroup(orgId, group.id, user.id);
      mutate((prev) => (prev ? {
        ...prev,
        users: prev.users.map((u) => {
          if (u.id !== user.id) return u;
          const rest = (u.groups ?? []).filter((g) => g.id !== group.id);
          return { ...u, groups: adding ? [...rest, { id: group.id, name: group.name }] : rest };
        }),
        groups: prev.groups.map((g) => (g.id === group.id && g._count
          ? { ...g, _count: { ...g._count, users: Math.max(0, g._count.users + (adding ? 1 : -1)) } }
          : g)),
      } : prev));
      say(adding
        ? `${user.fullName} added to ${displayGroupText(group.name)}.`
        : `${user.fullName} removed from ${displayGroupText(group.name)}.`, adding ? "created" : "ok");
    } catch (err) {
      fail(err.message || "Could not change this membership.");
    } finally {
      setPendingKey("");
    }
  }

  const multiOrg = adminOrgs.length > 1;
  const scopeName = scopeLabel(scopeOrgs, adminOrgs.length);
  const orgTile = (
    <>
      <span className="ug-tile__head">
        <span className="ug-tile__org"><OrgStack orgs={scopeOrgs} max={3} size={22} /></span>
        {multiOrg && (
          <span className="ug-badge">{allInScope ? "All" : `${scopeOrgs.length} of ${adminOrgs.length}`}</span>
        )}
      </span>
      <span className="ug-tile__body">
        <span className="ug-tile__title">{scopeName}</span>
        <span className="ug-tile__sub">{multiOrg ? "Choose 1 to all organisations" : "Groups for this organisation"}</span>
      </span>
    </>
  );

  const failedOrgs = (data?.failures ?? []).map((id) => orgById.get(id)?.name ?? "an organisation");

  return (
    <div className="ug-page">
      <div className="ug-page__inner">
        <header className="ug-masthead">
          <h1 className="ug-masthead__title">User groups</h1>
          {!loading && (
            <p className="ug-masthead__roll">
              <span className="ug-badge ug-badge--active">
                <span className="ug-dot" aria-hidden="true" />{roll.active} active
              </span>
              <span className="ug-badge ug-badge--inactive">
                <span className="ug-dot" aria-hidden="true" />{roll.inactive} inactive
              </span>
              {filtering && (
                <span className="ug-masthead__showing">{shown.length} of {roll.all} shown</span>
              )}
            </p>
          )}
          {scopeOrgs.length === 1 ? (
            <OrgBadge org={scopeOrgs[0]} here={scopeOrgs[0].id === orgId} />
          ) : scopeOrgs.length > 1 ? (
            <span className="ug-orgbadge" title={scopeOrgs.map((o) => o.name).join(", ")}>
              <OrgStack orgs={scopeOrgs} max={3} size={16} />
              <span className="ug-orgbadge__name">{scopeName}</span>
            </span>
          ) : null}
        </header>

        <div className="ug-toolbar">
          <div className="ug-toolbar__search-section">
            <span className="ug-toolbar__section-label">Search</span>
            <div className="ug-search">
              <svg className="ug-search__icon" width="13" height="13" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input ref={searchRef} className="ug-search__input" type="search" value={query}
                     onChange={(e) => setQuery(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
                     placeholder="Search groups" aria-label="Search groups" autoComplete="off" />
              {query && (
                <button type="button" className="ug-search__clear"
                        onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Clear</button>
              )}
            </div>
          </div>

          <div className="ug-toolbar__filter-section">
            <span className="ug-toolbar__section-label">Filter groups</span>
            <div className="ug-toolbar__filter-controls">
              <div className="ug-views" role="group" aria-label="Filter groups by status">
                {STATUS_TABS.map((t) => (
                  <button key={t.key} type="button"
                          className={"ug-views__opt" + (tab === t.key ? " ug-views__opt--on" : "")}
                          aria-pressed={tab === t.key}
                          disabled={(counts[t.key] ?? 0) === 0 && tab !== t.key}
                          onClick={() => setTab(t.key)}>
                    {t.label}<span className="ug-views__n">{counts[t.key] ?? 0}</span>
                  </button>
                ))}
              </div>
              <label className="ug-select">
                <span>Order by:</span>
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <Icon name="chevron" />
              </label>
            <button type="button" className="ug-invite-btn" aria-haspopup="dialog"
                    onClick={() => openModal("create")} disabled={!canCreate}
                    title={canCreate ? undefined : "You cannot create groups in any organisation"}>
              New Group
            </button>
            </div>
          </div>
        </div>

        {filtering && (
          <div className="ug-filters">
            <button type="button" className="ug-addfilter" onClick={clearFilters}>Clear filters</button>
          </div>
        )}

        {failedOrgs.length > 0 && (
          <p className="ug-partial" role="status">
            Could not load groups for {failedOrgs.join(", ")}. Those are not shown.
            {" "}<button type="button" className="ug-action" onClick={retry}>Try again</button>
          </p>
        )}

        {adminOrgs.length === 0 ? (
          <p className="ug-nomatch">You do not have access to an organisation user roster.</p>
        ) : loadError ? (
          <LoadError label="Groups" onRetry={retry} fullSection />
        ) : (
          <div className="ug-body">
            <div className="ug-tiles">
              <button type="button" className="ug-tile ug-tile--action"
                      onClick={() => openModal("create")} disabled={!canCreate}>
                <span className="ug-tile__icon"><Icon name="userPlus" /></span>
                <span className="ug-tile__body">
                  <span className="ug-tile__title">New Group</span>
                  <span className="ug-tile__sub">Combine users across organisations</span>
                </span>
              </button>

              {/* The scope: 1 to all organisations, each row with its logo. */}
              <div className="ug-menu ug-menu--tile">
                {multiOrg ? (
                  <button type="button" className="ug-tile ug-tile--action ug-tile--fill"
                          aria-haspopup="menu" aria-expanded={menuId === "org"}
                          onClick={() => setMenuId((m) => (m === "org" ? "" : "org"))}>
                    {orgTile}
                  </button>
                ) : (
                  <div className="ug-tile ug-tile--fill">{orgTile}</div>
                )}
                {menuId === "org" && (
                  <div className="ug-menu__pop ug-menu__pop--left" role="menu" aria-label="Organisations">
                    <span className="ug-menu__label">Show groups for</span>
                    <button type="button" role="menuitemcheckbox" aria-checked={allInScope}
                            className={"ug-menu__item" + (allInScope ? " ug-menu__item--on" : "")}
                            onClick={toggleAllScope}>
                      <span className="ug-box" aria-hidden="true" />
                      <span className="ug-menu__text">All organisations</span>
                      <span className="ug-menu__here">{adminOrgs.length}</span>
                    </button>
                    <span className="ug-menu__rule" />
                    <div className="ug-menu__scroll">
                      {adminOrgs.map((o) => {
                        const on = scopeIds.includes(o.id);
                        return (
                          <button key={o.id} type="button" role="menuitemcheckbox" aria-checked={on}
                                  className={"ug-menu__item" + (on ? " ug-menu__item--on" : "")}
                                  onClick={() => toggleScope(o.id)}>
                            <span className="ug-box" aria-hidden="true" />
                            <OrgMark org={o} size={18} />
                            <span className="ug-menu__text">{o.name}</span>
                            {o.id === orgId && <span className="ug-menu__here">current</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="ug-tile">
                <span className="ug-tile__head">
                  <span className="ug-tile__label"><Icon name="roster" />Your Roster</span>
                  <span className="ug-badge">{users.length ? "Synced" : "Empty"}</span>
                </span>
                <span className="ug-tile__body">
                  <span className="ug-tile__title">{users.length === 1 ? "1 person" : `${users.length} people`}</span>
                  <span className="ug-tile__sub">Available to add to groups</span>
                </span>
              </div>

              <div className="ug-tile">
                <span className="ug-tile__head">
                  <span className="ug-tile__label"><Icon name="ungrouped" />Ungrouped</span>
                  <span className={"ug-badge" + (ungrouped ? " ug-badge--warn" : " ug-badge--active")}>
                    {ungrouped ? "Needs a group" : "All grouped"}
                  </span>
                </span>
                <span className="ug-tile__body">
                  <span className="ug-tile__title">{plural(ungrouped, "user")}</span>
                  <span className="ug-tile__sub">Not in any group yet</span>
                </span>
              </div>
            </div>

            <div className="ug-section-head">
              <h2 className="ug-section-head__title">Groups <span>{groups.length}</span></h2>
              <Kebab label="Group list actions" open={menuId === "list"}
                     onToggle={() => setMenuId((m) => (m === "list" ? "" : "list"))}>
                <button type="button" role="menuitem"
                        onClick={() => { setMenuId(""); retry(); }}>Refresh list</button>
              </Kebab>
            </div>

            {loading ? (
              <p className="ug-muted">Loading groups…</p>
            ) : groups.length === 0 ? (
              <TabEmptyState
                icon={<DriversIcon size={44} />}
                title="No groups yet"
                hint="Create a group, choose which organisations it spans, then add people to it from its card."
              />
            ) : shown.length === 0 ? (
              <div className="ug-nomatch" role="status">
                <p className="ug-nomatch__line">
                  No {tab === "all" ? "" : `${tab} `}group
                  {needle && <> matching <span className="ug-nomatch__q">{query.trim()}</span></>}.
                </p>
                <button type="button" className="ug-action" onClick={clearFilters}>Clear filters</button>
              </div>
            ) : (
              <ul className="ug-grid">
                {shown.map((group) => {
                  const members = membersByGroup.get(group.id) ?? [];
                  const count = countFor(group);
                  const groupOrgs = orgsOf(group);
                  const manageable = !!homeOrgFor(group);
                  const creator = group.createdBy?.fullName ?? group.createdBy?.name ?? group.createdByName ?? "";
                  const created = fmtDate(group.createdAt);
                  return (
                    <li key={group.id}
                        className={"ug-card" + (menuId === group.id ? " ug-card--raised" : "")}>
                      <div className="ug-card__top">
                        <span className="ug-card__icon"><Icon name="group" /></span>
                        <span className="ug-card__text">
                          <span className="ug-card__name" title={displayGroupText(group.name)}>{displayGroupText(group.name)}</span>
                          <span className="ug-card__desc" title={group.description ? displayGroupText(group.description) : undefined}>
                            {group.description ? displayGroupText(group.description) : "No description added."}
                          </span>
                        </span>
                        {manageable && (
                          <Kebab label={`Actions for ${displayGroupText(group.name)}`} open={menuId === group.id}
                                 onToggle={() => setMenuId((m) => (m === group.id ? "" : group.id))}>
                            <button type="button" role="menuitem" onClick={() => openModal("edit", group)}>
                              Edit group
                            </button>
                            <button type="button" role="menuitem" className="ug-menu__danger"
                                    onClick={() => openModal("delete", group)}>
                              Delete group
                            </button>
                          </Kebab>
                        )}
                      </div>

                      <div className="ug-panel">
                        <div className="ug-row">
                          <span className="ug-row__label"><Icon name="building" />{groupOrgs.length > 1 ? "Organisations" : "Organisation"}</span>
                          {groupOrgs.length === 0 ? (
                            <span className="ug-row__none">—</span>
                          ) : groupOrgs.length === 1 ? (
                            <OrgBadge org={groupOrgs[0]} here={groupOrgs[0].id === orgId} />
                          ) : (
                            <span className="ug-orgbadge" title={groupOrgs.map((o) => o.name).join(", ")}>
                              <OrgStack orgs={groupOrgs} max={3} size={16} />
                              <span className="ug-orgbadge__name">{scopeLabel(groupOrgs, adminOrgs.length)}</span>
                            </span>
                          )}
                        </div>
                        <div className="ug-row">
                          <span className="ug-row__label"><Icon name="clock" />Status</span>
                          <StatusBadge active={count > 0} />
                        </div>
                        <div className="ug-row">
                          <span className="ug-row__label"><Icon name="people" />Members</span>
                          <span className="ug-row__members"
                                title={members.map((u) => u.fullName).join(", ") || undefined}>
                            <span className="ug-stack">
                              {members.slice(0, 3).map((u) => (
                                <Avatar key={u.id} name={u.fullName} email={u.email} />
                              ))}
                            </span>
                            <span className="ug-pill">{plural(count, "Member")}</span>
                          </span>
                        </div>
                        <div className="ug-row">
                          <span className="ug-row__label"><Icon name="user" />Created by</span>
                          {creator ? (
                            <span className="ug-creator" title={created ? `Created ${created}` : undefined}>
                              <Avatar name={creator} />{creator}
                            </span>
                          ) : (
                            <span className="ug-row__none">{created || "—"}</span>
                          )}
                        </div>
                      </div>

                      {manageable && (
                        <MemberPicker group={group} users={users} orgById={orgById}
                                      manageableOrgIds={groupOrgs.filter((o) => canIn(o.id, "user:assign_role"))
                                        .map((o) => o.id)}
                                      pendingKey={pendingKey}
                                      onToggle={(user) => toggleMembership(group, user)} />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── Create / edit / delete ── */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        id="ug-modal"
        title={modal?.mode === "edit" ? "Edit group" : modal?.mode === "delete" ? "Delete group" : "New group"}
        hint={modal?.mode === "delete" ? modal.group?.name : "People in a group can belong to different organisations."}
      >
        {modal?.mode === "delete" ? (
          <div className="ug-form">
            <div className="ug-modal__body">
              <p className="ug-danger__title">Delete {displayGroupText(modal.group?.name)}?</p>
              <p className="ug-danger__hint">
                The group is removed along with every membership in it, in every organisation it spans.
                The people themselves keep their accounts, their roles and their other groups. This cannot be undone.
              </p>
            </div>
            <footer className="ug-modal__foot">
              {error && <p className="ug-modal__error" id="ug-modal-error">{error}</p>}
              <div className="ug-modal__acts">
                <button type="button" className="ug-tbtn" onClick={closeModal} disabled={busy}>Keep the group</button>
                <button type="button" className="ug-submit ug-submit--danger" onClick={confirmDelete}
                        aria-describedby={error ? "ug-modal-error" : undefined} disabled={busy}>
                  {busy ? "Deleting…" : "Delete permanently"}
                </button>
              </div>
            </footer>
          </div>
        ) : (
          <form className="ug-form" onSubmit={saveGroup} noValidate>
            <div className="ug-modal__body">
              <label className="ug-field">
                <span className="ug-label">Group name</span>
                <input className="ug-input" type="text" required minLength={2} maxLength={100}
                       value={groupForm.name} disabled={busy}
                       onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))} />
              </label>
              <label className="ug-field">
                <span className="ug-label">Description (optional)</span>
                <textarea className="ug-input ug-input--area" rows={3} maxLength={500}
                          value={groupForm.description} disabled={busy}
                          onChange={(e) => setGroupForm((f) => ({ ...f, description: e.target.value }))} />
              </label>

              <fieldset className="ug-orgs-field">
                <legend className="ug-label">Organisations</legend>
                <p className="ug-orgs-field__hint">
                  Pick one, several, or all. People from any of them can be added to this group.
                </p>
                <OrgChecklist orgs={manageOrgs} value={modalOrgIds} onChange={setModalOrgIds} disabled={busy} />
              </fieldset>
            </div>
            <footer className="ug-modal__foot">
              {error && <p className="ug-modal__error" id="ug-modal-error">{error}</p>}
              <div className="ug-modal__acts">
                <button type="button" className="ug-tbtn" onClick={closeModal} disabled={busy}>Cancel</button>
                <button type="submit" className="ug-submit"
                        aria-describedby={error ? "ug-modal-error" : undefined}
                        disabled={busy || groupForm.name.trim().length < 2 || modalOrgIds.length === 0}>
                  {busy ? "Saving…" : modal?.mode === "edit" ? "Save changes" : "Create group"}
                </button>
              </div>
            </footer>
          </form>
        )}
      </Modal>

      {toast && (
        <div className={`ug-toast ug-toast--${toast.tone}`}
             role={toast.tone === "error" ? "alert" : "status"}
             aria-live={toast.tone === "error" ? "assertive" : "polite"}>
          <ToastMark tone={toast.tone} />
          <span className="ug-toast__text">{toast.text}</span>
          <button type="button" className="ug-toast__x" aria-label="Dismiss" onClick={() => setToast(null)}>
            {"\u2715"}
          </button>
        </div>
      )}
    </div>
  );
}