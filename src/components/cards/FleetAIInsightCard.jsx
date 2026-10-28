// The organisation's brief, at the foot of the left sidebar.
//
// Redesigned 2026-10-15 (Hallmark, component scope):
//
//   · Risk is a tinted badge in the head, beside the title, where it is read
//     first — not a coloured "↗ Risk:" line under the text.
//   · The brief is held to four lines with "Show more", where it used to
//     scroll inside the card. The card is pinned at the sidebar's foot, so
//     its height is taken from the menu above it; a toggle the operator
//     chooses beats a second scrollbar inside the first.
//   · Loading is three placeholder lines in the brief's own shape, so the
//     foot does not jump when the brief lands.
//   · The local fallback says what it is. "Fleet summary", and an
//     "AI unavailable" note where the time would be: it is the same counts
//     in fixed sentences, written whenever the server has no brief.
//
// Icons back, 2026-10-15 (operator: "return the icons… apply them with
// caution"). Four, each where it carries meaning a word alone does not: the
// sparkles that mark an AI brief (and only an AI brief), a shape per risk
// level so the badge reads without its colour, a clock on the time, and the
// chevron that says which way Show more goes. Tabler, like the rest of the app.
//
// One unit at a time, 2026-10-19 (operator: "the fleet ai insight should be
// for individual car, that i click on the map"). With a unit picked the card
// speaks for that unit; with none it is the fleet's. The title stays "Fleet AI
// Insight" either way (operator: "the title should remain as it was").
//
// The unit's insight, 2026-10-20 (operator: "make it smart by giving it memory
// and access to data … it should run on the background and when a unit is
// clicked it should be instantaneous"). The server writes each unit's insight
// in the background from fourteen days of its records and its own earlier
// insights (fleet-server vehicles/vehicle-insight); a pick reads the stored
// one at once: the headline, up to three findings and one action. The day's
// sentence (vehicles/:id/brief, fresh per pick) follows underneath as "Today".

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./FleetAIInsightCard.scss";
import { getFleetInsight } from "../../api/fleetInsight";
import { getVehicleBrief, getVehicleInsight } from "../../api/vehicleBrief";
import { useApiData } from "../../hooks/useApiData";
import LoadError from "../shared/LoadError";

// A different shape per level, so the badge reads without its colour.
const RISK_ICON = { Low: "shield-check", Medium: "alert-triangle", High: "alert-octagon" };
const riskWord = (r) => (r ? r.charAt(0).toUpperCase() + r.slice(1).toLowerCase() : null);

// The server regenerates each org's AI brief in the background and
// always answers from memory, so refreshing here is instant. Poll every
// 5 min: the server rewrites each brief every 10 (2026-10-16), and asking is
// also what keeps this org on its refresh list. The SWR cacheKey
// means every render paints from the last-known brief with no flicker.
const REFRESH_MS = 5 * 60_000;

/* A unit the sweep had not reached is written from facts on the click and
   its AI version a few seconds later: look again for half a minute. */
const MODEL_LOOK_MS = 3_000;
const MODEL_WAIT_MS = 30_000;

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/* The head's mark. Sparkles only when the model wrote the brief; the
   fixed-sentence summary gets a plain info mark, so the AI sign is never
   worn by text no model touched. */
function Mark({ ai }) {
  return <i className={`ti ti-${ai ? "sparkles" : "info-circle"} fai-mark`} aria-hidden="true" />;
}

function Head({ ai, risk, title }) {
  const r = RISK_ICON[risk] ? risk : null;
  return (
    <header className="fai-head">
      <Mark ai={ai} />
      {/* Only the server's brief is the model's. The local fallback is the
          same counts in fixed sentences, and is titled as what it is. */}
      <h3 className="fai-title">{title}</h3>
      {r && (
        <span className="fai-risk" data-risk={r.toLowerCase()} title={`Risk: ${r}`}>
          <i className={`ti ti-${RISK_ICON[r]}`} aria-hidden="true" />
          {r}
        </span>
      )}
    </header>
  );
}

function Skeleton({ cardClass }) {
  return (
    <section className={cardClass} aria-busy="true" aria-label="Fleet AI insight, loading">
      <Head ai title="Fleet AI Insight" />
      <div className="fai-skeleton" aria-hidden="true">
        <span /><span /><span />
      </div>
    </section>
  );
}

/** Folded to a few lines with Show more, measured rather than guessed. */
function useFold(deps) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  // A new brief starts folded again.
  useEffect(() => { setExpanded(false); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  // "Show more" only when the fold actually hides something. Measured folded,
  // when the text changes and when the window does (the sidebar's width
  // follows it). No ResizeObserver, as elsewhere in this app.
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el || el.classList.contains("fai-body--open")) return;
      const next = el.scrollHeight > el.clientHeight + 1;
      setClamped((prev) => (prev === next ? prev : next));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [...deps, expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref, expanded, setExpanded, clamped };
}

function Foot({ meta, fold, bodyId }) {
  return (
    <footer className="fai-foot">
      <span className="fai-meta">{meta}</span>
      {(fold.clamped || fold.expanded) && (
        <button
          type="button"
          className="fai-more"
          aria-expanded={fold.expanded}
          aria-controls={bodyId}
          onClick={() => fold.setExpanded((v) => !v)}
        >
          {fold.expanded ? "Show less" : "Show more"}
          <i className={`ti ti-chevron-${fold.expanded ? "up" : "down"}`} aria-hidden="true" />
        </button>
      )}
    </footer>
  );
}

/** `unit`: the picked unit ({ orgId, vehicleId, plate }), or null for the fleet. */
export default function FleetAIInsightCard({ companyId, unit = null, className = "" }) {
  const cardClass = `fleet-ai-card${className ? ` ${className}` : ""}`;
  return unit?.orgId && unit?.vehicleId
    ? <UnitInsight key={unit.vehicleId} unit={unit} cardClass={cardClass} />
    : <FleetBrief companyId={companyId} cardClass={cardClass} />;
}

/* ── the fleet's brief ───────────────────────────────────────────────────── */

function FleetBrief({ companyId, cardClass }) {
  const { data: insight, loading, error, retry } = useApiData(
    () => getFleetInsight({ companyId }),
    [companyId],
    { cacheKey: `ft-ai-insight:${companyId}` }
  );

  useEffect(() => {
    const t = setInterval(retry, REFRESH_MS);
    return () => clearInterval(t);
  }, [retry]);

  const msg = insight?.msg ?? "";
  const fold = useFold([msg, loading]);
  const bodyId = `fai-body-${companyId ?? "org"}`;

  if (error) {
    return (
      <div className={cardClass}>
        <LoadError label="Fleet AI insight" onRetry={retry} />
      </div>
    );
  }
  if (!loading && !insight) return null;
  if (loading || !insight) return <Skeleton cardClass={cardClass} />;

  // Not the model's: the browser's own summary (`local`), or the server's
  // facts-only brief, which it sends whenever the model failed or its reply
  // was rejected (`source: "facts"`).
  const notAi = insight.local || insight.source === "facts";
  const title = notAi ? "Fleet summary" : "Fleet AI Insight";

  return (
    <section className={cardClass} data-local={notAi ? "" : undefined} aria-label={title}>
      <Head ai={!notAi} risk={riskWord(insight.risk)} title={title} />

      {/* The brief alone. The card used to open with an "N/M active:" ratio
          (engines on over the fleet that reports), but the first sentence of
          the brief already says how the fleet is running — online, in transit,
          idling, parked — and those are the counts an operator acts on. The
          ratio only invited the question of which of the two numbers to trust. */}
      <p ref={fold.ref} id={bodyId} className={`fai-body${fold.expanded ? " fai-body--open" : ""}`}>
        {msg}
      </p>

      <Foot
        fold={fold}
        bodyId={bodyId}
        meta={insight.generatedAt
          ? <><i className="ti ti-clock" aria-hidden="true" />{`${notAi ? "AI unavailable · " : ""}Updated ${clock(insight.generatedAt)}`}</>
          : notAi ? "AI unavailable" : null}
      />
    </section>
  );
}

/* ── the picked unit's insight ───────────────────────────────────────────── */

function UnitInsight({ unit, cardClass }) {
  const { orgId, vehicleId } = unit;
  const pickedAt = useMemo(() => Date.now(), []);

  // The stored insight: instant, no model on the click.
  const { data: insight, loading, error, retry } = useApiData(
    () => getVehicleInsight({ orgId, vehicleId }),
    [orgId, vehicleId],
  );
  // The day's sentence, measured fresh for this pick; it may take a second.
  const askedFresh = useRef(false);
  const { data: today } = useApiData(
    () => {
      const fresh = !askedFresh.current;
      askedFresh.current = true;
      return getVehicleBrief({ orgId, vehicleId, fresh });
    },
    [orgId, vehicleId],
  );

  // A unit the sweep had not reached: its AI version lands a few seconds
  // after the click. An interval, not a timeout per answer: an unchanged
  // answer comes back as the same object, so nothing would re-arm a timeout.
  const waiting = insight != null && insight.source !== "model" && insight.findings?.length > 0;
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => {
      if (Date.now() - pickedAt > MODEL_WAIT_MS) clearInterval(t);
      else retry();
    }, MODEL_LOOK_MS);
    return () => clearInterval(t);
  }, [waiting, pickedAt, retry]);

  useEffect(() => {
    const t = setInterval(retry, REFRESH_MS);
    return () => clearInterval(t);
  }, [retry]);

  const fold = useFold([insight?.headline, today?.msg, loading]);
  const bodyId = `fai-body-${vehicleId}`;

  if (error) {
    return (
      <div className={cardClass}>
        <LoadError label="Fleet AI insight" onRetry={retry} />
      </div>
    );
  }
  if (loading && !insight) return <Skeleton cardClass={cardClass} />;
  // No insight and nothing to write one from: the day's sentence alone.
  if (!insight && !today?.msg) return null;

  const ai = insight?.source === "model";
  const title = ai || !insight ? "Fleet AI Insight" : "Fleet summary";

  return (
    <section className={cardClass} data-local={ai ? undefined : ""} aria-label={title}>
      <Head ai={ai} risk={riskWord(insight?.risk)} title={title} />

      <div
        ref={fold.ref}
        id={bodyId}
        className={`fai-body fai-unit${fold.expanded ? " fai-body--open" : ""}`}
        data-clamped={fold.clamped && !fold.expanded ? "" : undefined}
      >
        {insight && <p className="fai-headline">{insight.headline}</p>}
        {/* The action straight under the headline: it is what the operator
            came for, and the fold must never hide it. */}
        {insight?.action && (
          <p className="fai-action">
            <i className="ti ti-arrow-right" aria-hidden="true" />
            <span>{insight.action}</span>
          </p>
        )}
        {insight?.findings?.length > 0 && (
          <ul className="fai-findings">
            {insight.findings.map((f) => <li key={f.kind}>{f.text}</li>)}
          </ul>
        )}
        {today?.msg && (
          <p className="fai-today"><span className="fai-today-label">Today</span>{today.msg}</p>
        )}
      </div>

      <Foot
        fold={fold}
        bodyId={bodyId}
        meta={insight?.generatedAt
          ? <><i className="ti ti-clock" aria-hidden="true" />{`${ai ? "" : "AI unavailable · "}Updated ${clock(insight.generatedAt)}`}</>
          : null}
      />
    </section>
  );
}
