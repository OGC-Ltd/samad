/**
 * Escalating and de-escalating a LIVE fuel alert, from its window.
 *
 * An administrator (the org's system administrator, or the platform one)
 * marks the alert a confirmed theft or a faulty probe (escalate) or not a
 * theft (de-escalate), with a reason. This is the ONLY way an alert leaves the
 * dashboard (operator, 2026-09-30): there is no Delete, so every alert that
 * goes carries a decision, a note and who made it. The server keeps the row
 * and tells every open dashboard; this browser drops it straight away.
 *
 * The decision reaches the screen at once through a small store of decisions
 * made in this session, laid over the snapshot's `incident.review` until a new
 * snapshot carries it.
 */

import { useSyncExternalStore } from 'react';
import { apiFetch } from '../services/api';
import { dismissIncident } from './fuelDismissals';

const base = (orgId) => `/api/v1/organisations/${orgId}/fuel/thefts`;

// ── Who may decide ──────────────────────────────────────────────────────────

const rights = new Map(); // orgId -> Promise<boolean>
const rightsKnown = new Map(); // orgId -> boolean, once the answer is in

/** Whether this viewer may escalate or de-escalate here. Asked once per org. */
export function fetchReviewRights(orgId) {
  if (!orgId) return Promise.resolve(false);
  if (!rights.has(orgId)) {
    rights.set(orgId, apiFetch(`${base(orgId)}/review-rights`)
      .then((res) => {
        const ok = Boolean(res?.data?.canReview);
        rightsKnown.set(orgId, ok);
        return ok;
      })
      .catch(() => { rights.delete(orgId); return false; }));
  }
  return rights.get(orgId);
}

/**
 * The answer, if it is already in — so a window opened after lib/fuelPrefetch
 * asked shows its controls in its first frame instead of a moment later.
 */
export function reviewRightsNow(orgId) {
  return rightsKnown.get(orgId);
}

// ── Decisions made in this session ──────────────────────────────────────────

const listeners = new Set();
let decided = new Map(); // incidentId -> review

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const snapshot = () => decided;

export async function reviewIncident(orgId, incidentId, outcome, note, reason) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(incidentId)}/review`, {
    method: 'POST',
    body: JSON.stringify({ outcome, note, ...(outcome === 'ESCALATED' && reason ? { reason } : {}) }),
  });
  const review = res?.data?.review ?? null;
  if (review) {
    decided = new Map(decided).set(incidentId, review);
    listeners.forEach((fn) => fn());
  }
  // Decided = off the dashboard (the server has already done it for everyone).
  dismissIncident(incidentId);
  return review;
}

/** The incident's decision: this session's if one was made, else the snapshot's. */
export function useIncidentReview(incident) {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!incident) return null;
  return map.get(incident.id) ?? incident.review ?? null;
}

/** Test hook. */
export function _resetReviews() {
  decided = new Map();
  rights.clear();
  rightsKnown.clear();
}

// ── Wording ─────────────────────────────────────────────────────────────────

/**
 * What the decision is, and what the one button left should offer. A decided
 * alert offers only the other way; an undecided one offers both.
 */
export function reviewState(review) {
  const status = review?.status ?? null;
  if (status === 'CONFIRMED_THEFT') return { status, label: 'Escalated', meaning: 'confirmed theft', tone: 'bad', offer: ['DEESCALATED'] };
  if (status === 'NOT_THEFT') return { status, label: 'De-escalated', meaning: 'not a theft', tone: 'ok', offer: ['ESCALATED'] };
  // Escalated as a faulty probe: the alert has gone to Fuel Audit with its own
  // case, so there is nothing left to decide here.
  if (status === 'PROBE_FAULT') return { status, label: 'Escalated', meaning: 'faulty fuel probe · sent to Repairs', tone: 'warn', offer: [] };
  return { status: null, label: null, meaning: null, tone: null, offer: ['ESCALATED', 'DEESCALATED'] };
}

export const OUTCOME = {
  ESCALATED: { verb: 'Escalate', confirm: 'Escalate', placeholder: 'Choose what it is escalated as' },
  DEESCALATED: {
    verb: 'De-escalate', confirm: 'De-escalate as not a theft',
    placeholder: 'Why is this not a theft? e.g. refuel mis-read, a drain on record',
    hint: 'The alert leaves the map, recorded as not a theft with your reason.',
  },
};

/**
 * What an escalation is FOR. One Escalate button, and the case it is raised
 * to handle picked under it, so the button text follows the choice
 * ("Escalate as faulty fuel probe") and the next kind of escalation is one
 * more entry here rather than one more button. The ids are the server's
 * (fuel.schema ESCALATION_REASONS).
 */
export const ESCALATION_REASONS = [
  {
    id: 'theft',
    label: 'Confirmed theft',
    confirm: 'Escalate as confirmed theft',
    placeholder: 'Why is this a theft? e.g. seen on camera, driver admitted it',
    hint: 'The alert leaves the map, recorded as a confirmed theft with your reason.',
  },
  {
    id: 'probe_fault',
    label: 'Faulty fuel probe',
    confirm: 'Escalate as faulty fuel probe',
    placeholder: 'What the probe does wrong: jumps, flatlines, reads empty while full',
    hint: 'Not a theft. The alert leaves the map, a case opens in Fuel > Audit and a pending probe job is raised in '
      + 'Maintenance > Repairs. The case closes when that job is signed off fixed.',
  },
];
export const escalationReason = (id) => ESCALATION_REASONS.find((r) => r.id === id) ?? null;
