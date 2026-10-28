// Escalate / de-escalate, in the fuel incident window. See lib/fuelReview.
//
// Shows the decision when there is one (who, when, why), and to an
// administrator the way to make or change it: pick a direction, give a reason,
// confirm. Nothing for anyone else when the alert is undecided.

import { useEffect, useState } from "react";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import {
  ESCALATION_REASONS, OUTCOME, escalationReason, fetchReviewRights, reviewIncident, reviewRightsNow, reviewState,
  useIncidentReview,
} from "../../lib/fuelReview";
import "./SensorPanel.scss";
import "./FuelFollowUp.scss";
import "./FuelReview.scss";

const WHEN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});

export default function FuelReview({ incident }) {
  const { orgId } = useFleetLiveShared();
  const review = useIncidentReview(incident);
  const state = reviewState(review);
  // Already known when lib/fuelPrefetch asked first, so the controls are in the first frame.
  const [canReview, setCanReview] = useState(() => reviewRightsNow(orgId) ?? false);
  const [picking, setPicking] = useState(null); // 'ESCALATED' | 'DEESCALATED' | null
  // What an escalation is raised to handle (ESCALATION_REASONS); chosen, never assumed.
  const [reason, setReason] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    fetchReviewRights(orgId).then((ok) => { if (live) setCanReview(ok); });
    return () => { live = false; };
  }, [orgId]);

  // A different incident in the same window starts clean.
  useEffect(() => { setPicking(null); setReason(null); setNote(""); setError(null); }, [incident?.id]);

  if (!incident || (!state.status && !canReview)) return null;

  const chosen = picking === "ESCALATED" ? escalationReason(reason) : null;
  const needsReason = picking === "ESCALATED" && !chosen;
  const noteShort = note.trim().length < 3;
  const confirmText = picking === "ESCALATED" ? (chosen?.confirm ?? OUTCOME.ESCALATED.confirm) : OUTCOME[picking]?.confirm;
  const placeholder = picking === "ESCALATED" ? (chosen?.placeholder ?? OUTCOME.ESCALATED.placeholder) : OUTCOME[picking]?.placeholder;
  const cancel = () => { setPicking(null); setReason(null); setError(null); };

  const submit = async () => {
    if (busy || noteShort || needsReason) return;
    setBusy(true);
    setError(null);
    try {
      await reviewIncident(orgId, incident.id, picking, note.trim(), chosen?.id);
      setPicking(null);
      setReason(null);
      setNote("");
    } catch (err) {
      setError(err?.status === 403
        ? "Only an administrator can escalate or de-escalate a fuel alert."
        : err?.status === 409
          ? "This alert has already been decided and is off the map."
          : err?.message || "Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`frv${state.tone ? ` frv--${state.tone}` : ""}`}>
      {state.status && (
        <div className="frv-status">
          <span className="frv-chip">{state.label}</span>
          <span className="frv-meaning">{state.meaning}</span>
          <span className="frv-by">
            {review.by ?? "an administrator"}{review.at ? ` · ${WHEN.format(new Date(review.at))}` : ""}
          </span>
          {review.note && <p className="frv-note">{"“"}{review.note}{"”"}</p>}
        </div>
      )}

      {canReview && !picking && (
        <div className="frv-actions">
          {!state.status && <span className="frv-ask">Is this a theft?</span>}
          {state.offer.map((o) => (
            <button key={o} type="button"
                    className={`frv-btn frv-btn--${o === "ESCALATED" ? "up" : "down"}`}
                    onClick={() => setPicking(o)}>
              {OUTCOME[o].verb}
            </button>
          ))}
        </div>
      )}

      {picking && (
        <div className="frv-form">
          {picking === "ESCALATED" && (
            <div className="frv-reasons" role="radiogroup" aria-label="Escalate as">
              <span className="frv-ask">Escalate as</span>
              {ESCALATION_REASONS.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={reason === r.id}
                        className={`frv-reason${reason === r.id ? " frv-reason--on" : ""}`}
                        onClick={() => setReason(r.id)} disabled={busy}>
                  {r.label}
                </button>
              ))}
            </div>
          )}
          {(picking === "ESCALATED" ? chosen?.hint : OUTCOME[picking]?.hint) && (
            <p className="frv-hint">{picking === "ESCALATED" ? chosen.hint : OUTCOME[picking].hint}</p>
          )}
          <textarea
            className="frv-input"
            rows={2}
            autoFocus
            value={note}
            maxLength={2000}
            placeholder={placeholder}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Reason"
          />
          <div className="frv-actions">
            <button type="button" className="frv-btn" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button type="button"
                    className={`frv-btn frv-btn--solid frv-btn--${picking === "ESCALATED" ? "up" : "down"}`}
                    onClick={submit} disabled={busy || noteShort || needsReason}
                    title={needsReason ? "Choose what to escalate it as" : noteShort ? "Give a reason first" : undefined}>
              {busy ? "Saving…" : confirmText}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="sp4-root ffu-scope">
          <div className="sp4-toast sp4-toast--crit" role="alert">
            <span className="sp4-toast-text">{error}</span>
            <button type="button" className="sp4-toast-x" aria-label="Dismiss notification" onClick={() => setError(null)}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}
