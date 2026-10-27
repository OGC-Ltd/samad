/**
 * Follow-ups on deleted fuel alerts — the client half of the server's
 * FuelTheftFollowUp (fleet-server: modules/fuel/fuel-followup.service).
 *
 * Deleting a fuel alert opens a follow-up for the organisation. Somebody with
 * case rights (`fuel_theft:triage`), other than the person who deleted it,
 * accepts it; from then on only they can add notes and escalate it (a
 * confirmed theft) or de-escalate it (not a theft). Anyone who could accept it
 * may decline it instead, with a reason; the organisation's administrator can
 * then assign it to a named person, who alone may accept or decline it. Every
 * step is logged server-side with who took it.
 *
 * One module-level store so the map button, the live feed and the case window
 * all read the same list, refetched when the server says one moved
 * (`fuel_followup` over SSE, see useFleetLive) rather than on a timer.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../services/api';

const base = (orgId) => `/api/v1/organisations/${orgId}/fuel/followups`;

// ── API ─────────────────────────────────────────────────────────────────────

export async function fetchFollowUps(orgId, status = 'active') {
  const res = await apiFetch(`${base(orgId)}?status=${status}&limit=200`);
  return res?.data ?? [];
}

export async function fetchFollowUp(orgId, id) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(id)}`);
  return res?.data ?? null;
}

const post = async (orgId, id, verb, body) => {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(id)}/${verb}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  followUpsChanged();
  return res?.data ?? null;
};

export const acceptFollowUp     = (orgId, id)       => post(orgId, id, 'accept');
export const declineFollowUp    = (orgId, id, note) => post(orgId, id, 'decline', { note });
export const assignFollowUp     = (orgId, id, assigneeId, note) =>
  post(orgId, id, 'assign', { assigneeId, ...(note ? { note } : {}) });
export const recallFollowUp     = (orgId, id, note) => post(orgId, id, 'recall', note ? { note } : {});

/** Who an administrator may hand this follow-up to (administrators only). */
export async function fetchAssignees(orgId, id) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(id)}/assignees`);
  return res?.data ?? [];
}
export const noteFollowUp       = (orgId, id, note) => post(orgId, id, 'notes', { note });
/** `reason` is what the escalation is for (lib/fuelReview ESCALATION_REASONS):
 *  'theft' closes it as a confirmed theft, 'probe_fault' sends it to Fuel
 *  Audit with a probe job in Repairs. */
export const escalateFollowUp   = (orgId, id, note, reason = 'theft') => post(orgId, id, 'escalate', { note, reason });
export const deescalateFollowUp = (orgId, id, note) => post(orgId, id, 'deescalate', { note });
/** Decided as a faulty fuel probe: stays open on the Fuel Audit page and
 *  raises (or joins) a pending probe job in Maintenance > Repairs. */
export const probeFaultFollowUp = (orgId, id, note) => post(orgId, id, 'probe-fault', { note });
/** A new probe job for an audit case whose last one was signed off unfixed. */
export const reraiseProbeRepair = (orgId, id, note) => post(orgId, id, 'repair', { note });

/** The Fuel Audit page: probe-fault cases grouped by unit, with each unit's
 *  probe jobs in Repairs and its dead-probe episodes. */
export async function fetchFuelAudit(orgId) {
  const res = await apiFetch(`/api/v1/organisations/${orgId}/fuel/audit`);
  return res?.data ?? [];
}

// ── Wording ────────────────────────────────────────────────────────────────

export const STATUS_LABEL = {
  OPEN:        'Waiting to be accepted',
  ACCEPTED:    'Under review',
  ESCALATED:   'Confirmed theft',
  DEESCALATED: 'Not a theft',
  PROBE_FAULT: 'Faulty probe · in repair',
  PROBE_FIXED: 'Probe repaired',
};

export const ACTION_LABEL = {
  OPENED:      'deleted the alert',
  ACCEPTED:    'accepted the follow-up',
  NOTE:        'added a note',
  ESCALATED:   'escalated it: confirmed theft',
  DEESCALATED: 'de-escalated it: not a theft',
  ASSIGNED:    'assigned it',
  DECLINED:    'declined it',
  RECALLED:    'recalled it',
  PROBE_FAULT:   'found it was a faulty fuel probe',
  REPAIR_RAISED: 'sent the probe to Repairs',
  REPAIR_FAILED: 'signed the probe repair off without a fix',
  PROBE_FIXED:   'signed the probe repair off fixed, closing the case',
};

/**
 * Where a follow-up stands, one step finer than its status: an OPEN one is
 * waiting for anybody, waiting for the person it was assigned to, or declined
 * and waiting for an administrator.
 */
export function followUpStage(f) {
  if (f?.status !== 'OPEN') return f?.status ?? null;
  if (f.assignedTo) return 'ASSIGNED';
  if (f.needsAssigning) return 'NEEDS_ASSIGNING';
  return 'OPEN';
}

export const STAGE_LABEL = {
  ...STATUS_LABEL,
  ASSIGNED:        'Assigned',
  NEEDS_ASSIGNING: 'Needs assigning',
};

/**
 * What this viewer may do with a follow-up, from the server's per-viewer flags
 * and the viewer's own permission. The server enforces all of it; this only
 * decides which buttons to draw.
 *
 * `assign` and `recall` are separate from the rest: an administrator may place
 * a follow-up, or take it back from whoever holds it, whatever they could do
 * with it themselves.
 */
export function followUpAbilities(f, canTriage) {
  const none = { accept: false, decline: false, act: false, recall: false };
  if (!f || !canTriage) return { ...none, assign: false, why: canTriage ? null : 'no-rights' };
  const assign = Boolean(f.viewer?.canAssign) && (f.status === 'OPEN' || f.status === 'ACCEPTED');
  // Something to take back: an assignee who has not accepted, or a reviewer.
  const recall = assign && (f.status === 'ACCEPTED' || Boolean(f.assignedTo));
  if (f.status === 'OPEN') {
    if (f.viewer?.deletedIt) return { ...none, assign, recall, why: 'deleted-it' };
    if (f.assignedTo && !f.viewer?.assignedToMe) return { ...none, assign, recall, why: 'assigned-elsewhere' };
    // Somebody who declined may still change their mind and accept; they
    // cannot decline twice.
    return { ...none, assign, recall, accept: true, decline: !f.viewer?.declinedIt, why: null };
  }
  if (f.status === 'ACCEPTED') {
    return f.viewer?.ownsIt
      ? { ...none, assign, recall, act: true, why: null }
      : { ...none, assign, recall, why: 'someone-else' };
  }
  return { ...none, assign: false, why: 'closed' };
}

/**
 * Whether this follow-up is waiting on THIS viewer: one they may accept (and
 * have not declined), one assigned to them, one they accepted and have not
 * decided, or, for an administrator, one declined and held by nobody. What
 * the System badge counts.
 */
export function needsMe(f) {
  if (f?.status === 'OPEN') {
    if (f.needsAssigning && f.viewer?.canAssign) return true;
    if (f.viewer?.deletedIt) return false;
    if (f.assignedTo) return Boolean(f.viewer?.assignedToMe);
    return !f.viewer?.declinedIt;
  }
  if (f?.status === 'ACCEPTED') return Boolean(f.viewer?.ownsIt);
  return false;
}

// ── Shared list store ──────────────────────────────────────────────────────

const listeners = new Set();
let state = { orgId: null, items: [], loading: false, error: null };
let generation = 0;

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

async function load(orgId) {
  const mine = ++generation;
  set({ loading: true });
  try {
    const items = await fetchFollowUps(orgId, 'active');
    if (mine === generation) set({ orgId, items, loading: false, error: null });
  } catch (err) {
    // 403 = no case rights here; the button simply does not appear.
    if (mine === generation) set({ orgId, items: [], loading: false, error: err?.status ?? 'error' });
  }
}

/** Something moved on the server (SSE) or here (a POST): read the list again. */
export function followUpsChanged() {
  if (state.orgId) load(state.orgId);
  window.dispatchEvent(new CustomEvent('ft-fuel-followup-changed'));
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const snapshot = () => state;

/**
 * The organisation's outstanding follow-ups (waiting or under review).
 * Pass `enabled = false` for a viewer without case rights: nothing is fetched.
 */
export function useFollowUps(orgId, enabled = true) {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!enabled || !orgId) return;
    if (state.orgId !== orgId) { state = { ...state, orgId, items: [] }; }
    load(orgId);
  }, [orgId, enabled]);
  return enabled && s.orgId === orgId ? s : { orgId, items: [], loading: false, error: null };
}

// ── Which case window is open ──────────────────────────────────────────────

const openListeners = new Set();
let openId = null;

export function openFollowUp(id) {
  openId = id ?? null;
  openListeners.forEach((fn) => fn());
}
export const closeFollowUp = () => openFollowUp(null);

export function useOpenFollowUp() {
  return useSyncExternalStore(
    (fn) => { openListeners.add(fn); return () => openListeners.delete(fn); },
    () => openId,
    () => openId,
  );
}

/* The follow-up feed items that belong to the Fuel Audit (a probe fault and
   its repair). Every other follow-up item is about the case a DELETED alert
   opens, and a deleted alert is removed from the UI for good (operator,
   2026-09-30), so those are never shown. */
const AUDIT_FEED_KINDS = new Set(['probe_fault', 'repair_raised', 'repair_failed', 'probe_fixed']);
const FEED_KIND = /^fu-.+?-(opened|escalated|deescalated|assigned|declined|recalled|probe_fault|repair_raised|repair_failed|probe_fixed)(?:-\d+)?$/;

/** True for a feed item about a deleted alert's case: hidden from every feed. */
export function isDeletedCaseItem(item) {
  const fromType = typeof item?.alertType === 'string' && item.alertType.startsWith('FUEL_FOLLOWUP_')
    ? item.alertType.slice('FUEL_FOLLOWUP_'.length).toLowerCase() : null;
  const kind = fromType ?? FEED_KIND.exec(item?.id ?? '')?.[1] ?? null;
  return Boolean(kind) && !AUDIT_FEED_KINDS.has(kind);
}

/**
 * The follow-up a Live Feed item is about, if any. Live items carry
 * `followUpId`; items read back from history lose extras but keep their id,
 * which carries it too. `true` means "a follow-up, but which one is unknown".
 */
export function feedItemFollowUp(item) {
  if (item?.followUpId) return item.followUpId;
  // The feed id is minted as `fu-<followUpId>-<what>` (fuel-followup.service),
  // and it survives the round trip through history where extras do not.
  // Assignments, declines and recalls repeat, so theirs end in a timestamp.
  const m = /^fu-(.+?)-(opened|escalated|deescalated|assigned|declined|recalled|probe_fault|repair_raised|repair_failed|probe_fixed)(?:-\d+)?$/.exec(item?.id ?? '');
  if (m) return m[1];
  return typeof item?.alertType === 'string' && item.alertType.startsWith('FUEL_FOLLOWUP_') ? true : null;
}
