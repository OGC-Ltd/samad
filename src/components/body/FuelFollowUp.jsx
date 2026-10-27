/**
 * Follow-ups on deleted fuel alerts: the case window. See lib/fuelFollowUps for
 * the rules and the store; the Fuel Audit page lists the probe-fault cases.
 *
 * The case window is mounted once, in the header (FuelFollowUpHost), so it can
 * be opened from anywhere — the System screen, the Live Feed, a phone's feed
 * sheet.
 *
 * It is the Repair report dialog's shape, built from the same `sp4-modal`
 * parts: a pinned head with the title and ×, the unit as a `sp4-repair-item`
 * card with outcome chips and a "what you found" box, and a pinned foot with
 * the count of what is missing beside Cancel and the one submit button. Those
 * classes read the `--sp4-*` tokens, which live on `.sp4-root`, so the host
 * wraps the dialog in one (`display: contents`, see FuelFollowUp.css).
 *
 * Four modes share that shape. The main one accepts or decides. "Decline"
 * asks for the reason before saying no. "Assign" is the administrator's: pick
 * a person from the organisation's case holders and hand it to them. "Recall"
 * is the administrator's too: take it back from whoever holds it. Each mode
 * owns the foot's one submit button, so the dialog never offers two primary
 * actions at once.
 */

import { useEffect, useId, useRef, useState } from "react";
import "./SensorPanel.css";
import "./FuelFollowUp.css";
import { usePermissions } from "../../hooks/usePermissions";
import useFocusTrap from "../../hooks/useFocusTrap";
import {
  ACTION_LABEL, STAGE_LABEL, acceptFollowUp, assignFollowUp, closeFollowUp, declineFollowUp,
  deescalateFollowUp, escalateFollowUp, fetchAssignees, fetchFollowUp, followUpAbilities,
  followUpStage, noteFollowUp, recallFollowUp, useOpenFollowUp,
} from "../../lib/fuelFollowUps";
import { STAGE_LABEL as REPAIR_STAGE_LABEL } from "../../api/repairs";
import { ESCALATION_REASONS, escalationReason } from "../../lib/fuelReview";

const TZ = "Africa/Nairobi";
const WHEN = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
export const when = (v) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? WHEN.format(t) : "-";
};
export const litres = (ml) => (ml == null ? "-" : `${(ml / 1000).toFixed(1)} L`);

// The System screen's pill tones, so a follow-up reads the same in both.
export const STAGE_PILL = {
  OPEN: "warn", ASSIGNED: "info", NEEDS_ASSIGNING: "inc",
  ACCEPTED: "info", ESCALATED: "inc", DEESCALATED: "con",
  PROBE_FAULT: "warn", PROBE_FIXED: "con",
};

/* The two decisions, as the repair dialog's outcome chips: red to escalate,
   green to clear. What an escalation is FOR is chosen under it
   (ESCALATION_REASONS, shared with the alert window), so a new kind of
   escalation is a new reason, not a new button. */
const DECISIONS = [
  { id: "escalate",   label: "Escalate",    chip: "cannot_fix" },
  { id: "deescalate", label: "De-escalate", chip: "fixed" },
];

/** A readable error from an ApiError, preferring the server's own sentence. */
function errorText(err) {
  if (err?.status === 403 && !err?.message) return "You don't have permission to do that.";
  return err?.message || "That didn't go through. Try again.";
}

/** Why this viewer has no buttons, in one line. */
function whyNot(f, why) {
  if (why === "deleted-it") return "You deleted this alert, so someone else has to accept its follow-up.";
  if (why === "someone-else") return `${f.acceptedBy?.fullName ?? "Someone else"} accepted this follow-up; only they can decide it.`;
  if (why === "assigned-elsewhere") return `Assigned to ${f.assignedTo?.fullName ?? "someone else"}; only they can accept or decline it.`;
  if (why === "no-rights") return "Your role cannot take on fuel follow-ups.";
  if (f?.status === "PROBE_FAULT") {
    const job = f.repairItem;
    if (!job) return "A faulty fuel probe. Its repair job is no longer in Repairs; raise a new one from Fuel > Audit.";
    if (job.resolvedAt && job.stage !== "fixed") {
      return "A faulty fuel probe. Its repair was signed off without a fix, so the case stays open: raise a new job from Fuel > Audit.";
    }
    return `A faulty fuel probe, waiting on its repair in Maintenance > Repairs (${REPAIR_STAGE_LABEL[job.stage] ?? job.stage}). `
      + "It closes when a technician signs the job off fixed.";
  }
  if (f?.status === "PROBE_FIXED") return "A faulty fuel probe, repaired. The case closed when the job was signed off fixed.";
  return null;
}

/** One line of the log, naming the person an assignment went to. */
function logLine(a) {
  if (a.kind === "ASSIGNED") return a.subject ? `assigned it to ${a.subject.fullName}` : "assigned it";
  if (a.kind === "RECALLED") return a.subject ? `recalled it from ${a.subject.fullName}` : "recalled it";
  return ACTION_LABEL[a.kind] ?? a.kind;
}

// ── The case window ────────────────────────────────────────────────────────

function FollowUpWindow({ id, orgId, canTriage }) {
  const [f, setF] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [mode, setMode] = useState("main"); // 'main' | 'decline' | 'assign' | 'recall'
  const [note, setNote] = useState("");
  // De-escalate is picked to begin with (operator, 2026-10-20: "the
  // deescalate button should be selected by default").
  const [decision, setDecision] = useState("deescalate"); // 'escalate' | 'deescalate' | null
  const [reason, setReason] = useState(null);     // what an escalation is for: ESCALATION_REASONS
  const [assignees, setAssignees] = useState(null); // null until loaded
  const [assigneeId, setAssigneeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const titleId = useId();
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true);

  // Load, and reload whenever anyone moves this follow-up (SSE → store event).
  useEffect(() => {
    let live = true;
    const read = () => fetchFollowUp(orgId, id)
      .then((d) => { if (live) { setF(d); setLoadError(null); } })
      .catch((e) => { if (live) setLoadError(errorText(e)); });
    read();
    window.addEventListener("ft-fuel-followup-changed", read);
    return () => { live = false; window.removeEventListener("ft-fuel-followup-changed", read); };
  }, [orgId, id]);

  // The picker's people, fetched the first time an administrator opens it.
  useEffect(() => {
    if (mode !== "assign" || assignees) return undefined;
    let live = true;
    fetchAssignees(orgId, id)
      .then((list) => { if (live) setAssignees(list); })
      .catch((e) => { if (live) { setAssignees([]); setError(errorText(e)); } });
    return () => { live = false; };
  }, [mode, assignees, orgId, id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) closeFollowUp(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy]);

  const can = followUpAbilities(f, canTriage);
  const inc = f?.incident;
  const stage = followUpStage(f);
  const noteOk = note.trim().length >= 3;

  const switchMode = (next) => {
    setMode(next);
    setNote("");
    setDecision("deescalate");
    setReason(null);
    setAssigneeId("");
    setError(null);
  };

  /* What the one submit button does, and what is still missing before it can.
     The repair dialog's rule: a dead button always has its reason beside it. */
  let submit = null;
  let missing = null;
  const chosen = decision === "escalate" ? escalationReason(reason) : null;
  if (mode === "decline") {
    submit = { label: "Decline follow-up", busyLabel: "Declining…", danger: true, run: () => declineFollowUp(orgId, id, note.trim()) };
    if (!noteOk) missing = "Say why you are declining";
  } else if (mode === "recall") {
    submit = { label: "Recall follow-up", busyLabel: "Recalling…", danger: true, run: () => recallFollowUp(orgId, id, note.trim()) };
  } else if (mode === "assign") {
    submit = { label: "Assign", busyLabel: "Assigning…", run: () => assignFollowUp(orgId, id, assigneeId, note.trim()) };
    if (!assigneeId) missing = "Choose who to assign it to";
  } else if (can.accept) {
    submit = { label: "Accept follow-up", busyLabel: "Accepting…", run: () => acceptFollowUp(orgId, id) };
  } else if (can.act) {
    if (decision === "escalate") {
      submit = {
        label: chosen?.confirm ?? "Escalate", busyLabel: "Saving…", danger: chosen?.id === "theft",
        run: () => escalateFollowUp(orgId, id, note.trim(), chosen.id),
      };
    } else if (decision === "deescalate") {
      submit = { label: "De-escalate as not a theft", busyLabel: "Saving…", run: () => deescalateFollowUp(orgId, id, note.trim()) };
    } else {
      submit = { label: "Add note", busyLabel: "Adding…", run: () => noteFollowUp(orgId, id, note.trim()) };
    }
    if (decision === "escalate" && !chosen) missing = "Choose what to escalate it as";
    else if (!noteOk) missing = decision ? "Say what you found" : "Write a note, or choose an outcome";
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!submit || missing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await submit.run();
      if (next) setF(next);
      switchMode("main");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sp4-root ffu-scope">
      <div
        className="sp4-modal-overlay"
        role="presentation"
        onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) closeFollowUp(); }}
      >
        {error && (
          <div className="sp4-toast sp4-toast--crit" role="alert">
            <span className="sp4-toast-text">{error}</span>
            <button type="button" className="sp4-toast-x" aria-label="Dismiss notification" onClick={() => setError(null)}>×</button>
          </div>
        )}
        <div className="sp4-modal sp4-modal--narrow ffu-modal" ref={dialogRef}
             role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="sp4-modal-head">
            <span className="sp4-repair-title" id={titleId}>
              {{ decline: "Decline follow-up", assign: "Assign follow-up", recall: "Recall follow-up" }[mode] ?? "Fuel follow-up · 1 alert"}
            </span>
            <button type="button" className="sp4-modal-x" onClick={closeFollowUp} disabled={busy}
                    aria-label="Close" title="Close">×</button>
          </div>

          <form className="sp4-repair-form" onSubmit={onSubmit} noValidate>
            <div className="sp4-modal-body">
              {!f && !loadError && <p className="ffu-muted">Loading…</p>}
              {loadError && <div className="sp4-banner sp4-banner--crit" role="alert">{loadError}</div>}

              {f && (
                <>
                  <div className="sp4-repair-item">
                    <div className="sp4-repair-itemhead">
                      <span className="sp4-repair-reg">{inc.plate}</span>
                      <span className="sp4-repair-fault">{litres(inc.volumeMl)} lost · {when(inc.beganAt)}</span>
                      <span className={"sp4-pill sp4-pill--" + (STAGE_PILL[stage] ?? "none") + " ffu-pill"}>
                        {STAGE_LABEL[stage] ?? f.status}
                      </span>
                    </div>

                    <dl className="ffu-facts">
                      <div><dt className="sp4-label">Deleted by</dt><dd>{f.dismissedBy?.fullName ?? "-"}</dd></div>
                      {f.status === "OPEN" && f.assignedTo ? (
                        <div><dt className="sp4-label">Assigned to</dt><dd>{f.assignedTo.fullName}</dd></div>
                      ) : (
                        <div><dt className="sp4-label">Accepted by</dt><dd>{f.acceptedBy?.fullName ?? "Nobody yet"}</dd></div>
                      )}
                      <div><dt className="sp4-label">Reported</dt><dd>{when(inc.detectedAt)}</dd></div>
                      {inc.location && <div><dt className="sp4-label">Where</dt><dd>{inc.location}</dd></div>}
                    </dl>

                    {/* ── Decline: the reason, then the foot's red button ── */}
                    {mode === "decline" && (
                      <>
                        <label className="sp4-field">
                          <span className="sp4-label">Why you are declining</span>
                          <textarea
                            className="sp4-textarea"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="On leave, not your site, a conflict of interest…"
                            maxLength={2000}
                            disabled={busy}
                            rows={2}
                            autoFocus
                          />
                        </label>
                        <span className="ffu-muted">
                          {f.viewer?.assignedToMe
                            ? "It goes back to the administrator to assign to someone else."
                            : "An administrator will be asked to assign it to someone."}
                        </span>
                      </>
                    )}

                    {/* ── Recall: take it back, with an optional reason ── */}
                    {mode === "recall" && (
                      <>
                        <label className="sp4-field">
                          <span className="sp4-label">Reason (optional)</span>
                          <textarea
                            className="sp4-textarea"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Why it is being taken back: absence, workload, a conflict…"
                            maxLength={2000}
                            disabled={busy}
                            rows={2}
                            autoFocus
                          />
                        </label>
                        <span className="ffu-muted">
                          {f.status === "ACCEPTED"
                            ? `${f.acceptedBy?.fullName ?? "The reviewer"} stops reviewing it. `
                            : `${f.assignedTo?.fullName ?? "The assignee"} will no longer be able to accept it. `}
                          It goes back to waiting, and you can assign it to someone else.
                        </span>
                      </>
                    )}

                    {/* ── Assign: the administrator's picker ── */}
                    {mode === "assign" && (
                      <>
                        <label className="sp4-field">
                          <span className="sp4-label">Assign to</span>
                          <select
                            className="sp4-assignment-select ffu-assign-select"
                            value={assigneeId}
                            onChange={(e) => setAssigneeId(e.target.value)}
                            disabled={busy || !assignees}
                          >
                            <option value="">{assignees ? "Choose a person…" : "Loading people…"}</option>
                            {(assignees ?? []).map((p) => (
                              <option key={p.id} value={p.id}>{p.fullName}{p.email ? ` · ${p.email}` : ""}</option>
                            ))}
                          </select>
                        </label>
                        {assignees && assignees.length === 0 && (
                          <span className="sp4-repair-why">Nobody else in this organisation holds fuel case rights.</span>
                        )}
                        <label className="sp4-field">
                          <span className="sp4-label">Note (optional)</span>
                          <textarea
                            className="sp4-textarea"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Why this person, or what to look at first"
                            maxLength={2000}
                            disabled={busy}
                            rows={2}
                          />
                        </label>
                        {f.status === "ACCEPTED" && (
                          <span className="ffu-muted">
                            {f.acceptedBy?.fullName ?? "The reviewer"} will lose it; the new person has to accept it.
                          </span>
                        )}
                      </>
                    )}

                    {/* ── Main: decide it ── */}
                    {mode === "main" && can.act && (
                      <>
                        <div className="sp4-repair-outcomes" role="group" aria-label={`Outcome for ${inc.plate}`}>
                          {DECISIONS.map((d) => (
                            <button
                              key={d.id}
                              type="button"
                              className={"sp4-filter-chip sp4-out-chip sp4-out-chip--" + d.chip
                                         + (decision === d.id ? " sp4-out-chip--on" : "")}
                              aria-pressed={decision === d.id}
                              onClick={() => { setDecision(decision === d.id ? null : d.id); setReason(null); }}
                              disabled={busy}
                            >{d.label}</button>
                          ))}
                        </div>

                        {decision === "escalate" && (
                          <div className="sp4-repair-outcomes" role="radiogroup" aria-label="Escalate as">
                            <span className="sp4-label ffu-reason-label">Escalate as</span>
                            {ESCALATION_REASONS.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                role="radio"
                                aria-checked={reason === r.id}
                                className={"sp4-filter-chip sp4-out-chip sp4-out-chip--"
                                           + (r.id === "theft" ? "cannot_fix" : "needs_spare")
                                           + (reason === r.id ? " sp4-out-chip--on" : "")}
                                onClick={() => setReason(r.id)}
                                disabled={busy}
                              >{r.label}</button>
                            ))}
                          </div>
                        )}

                        <label className="sp4-field">
                          <span className="sp4-label">
                            {decision ? "What you found" : "Note"}
                          </span>
                          <textarea
                            className="sp4-textarea"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder={decision === "escalate"
                              ? (chosen?.placeholder ?? "Choose what it is escalated as first")
                              : decision === "deescalate"
                                ? "Why it is not a theft: a refuel, a drain on record"
                                : "What you checked, or who you spoke to"}
                            maxLength={2000}
                            disabled={busy}
                            rows={2}
                          />
                        </label>
                        {chosen?.hint && <span className="ffu-muted">{chosen.hint}</span>}
                        {missing && decision && <span className="sp4-repair-why">{missing}</span>}
                      </>
                    )}

                    {mode === "main" && f.needsAssigning && can.assign && (
                      <span className="sp4-repair-why">Declined, and nobody holds it: assign it to someone.</span>
                    )}
                    {mode === "main" && can.accept && (
                      <span className="ffu-muted">
                        {f.viewer?.assignedToMe
                          ? `${f.assignedBy?.fullName ?? "An administrator"} assigned this to you. Accept it, or decline with a reason.`
                          : "Accepting makes you responsible for deciding this one."}
                      </span>
                    )}
                    {mode === "main" && !can.accept && !can.act && whyNot(f, can.why) && (
                      <span className="ffu-muted">{whyNot(f, can.why)}</span>
                    )}
                  </div>

                  <div className="sp4-field">
                    <span className="sp4-label">What was done</span>
                    <ol className="ffu-log">
                      {f.actions.map((a) => (
                        <li key={a.id} className={`ffu-log-item ffu-log-item--${a.kind.toLowerCase()}`}>
                          <div className="ffu-log-line">
                            <strong>{a.actor?.fullName ?? "Someone"}</strong> {logLine(a)}
                            <span className="ffu-log-when">{when(a.at)}</span>
                          </div>
                          {a.note && <p className="ffu-log-note">{a.note}</p>}
                        </li>
                      ))}
                    </ol>
                  </div>
                </>
              )}
            </div>

            <div className="sp4-modal-foot">
              {missing && <span className="sp4-repair-pending">{missing}</span>}
              {mode === "main" ? (
                <>
                  {/* The side doors lead, the way the repair foot keeps its
                      secondary buttons before Cancel and the submit. */}
                  {can.recall && (
                    <button type="button" className={"sp4-ghost-btn" + (can.assign || can.decline ? "" : " ffu-foot-lead")}
                            onClick={() => switchMode("recall")} disabled={busy}>
                      Recall…
                    </button>
                  )}
                  {can.assign && (
                    <button type="button" className={"sp4-ghost-btn" + (can.decline ? "" : " ffu-foot-lead")}
                            onClick={() => switchMode("assign")} disabled={busy}>
                      {f?.assignedTo || f?.status === "ACCEPTED" ? "Reassign…" : "Assign…"}
                    </button>
                  )}
                  {can.decline && (
                    <button type="button" className="sp4-ghost-btn ffu-foot-lead"
                            onClick={() => switchMode("decline")} disabled={busy}>
                      Decline…
                    </button>
                  )}
                  <button type="button" className="sp4-ghost-btn" onClick={closeFollowUp} disabled={busy}>
                    {submit ? "Cancel" : "Close"}
                  </button>
                </>
              ) : (
                <button type="button" className="sp4-ghost-btn" onClick={() => switchMode("main")} disabled={busy}>
                  Back
                </button>
              )}
              {submit && (
                <button
                  type="submit"
                  className={"sp4-submit-btn" + (submit.danger ? " ffu-submit--danger" : "")}
                  disabled={busy || Boolean(missing)}
                >
                  {busy ? submit.busyLabel : submit.label}
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Mount once; renders the case window for whichever follow-up is open. */
export function FuelFollowUpHost() {
  const id = useOpenFollowUp();
  const { orgId, can } = usePermissions();
  if (!id || !orgId) return null;
  return <FollowUpWindow key={id} id={id} orgId={orgId} canTriage={can("fuel_theft:triage")} />;
}
