// PDF export button used across screens.
//
// SELF-GATING. Every report button in the app is this component, so the
// permission check lives here rather than at each of the eight call sites — a
// check repeated eight times is a check forgotten at the ninth.
//
// Four of those call sites render their PDF entirely in the browser from data
// already loaded, so there is no request for the server to refuse. For those
// the button IS the control, which is the whole reason this cannot be left to
// the API alone.
//
// Absent rather than disabled: a report an operator may not take is not a
// temporarily unavailable one, and a greyed button with a tooltip advertises a
// capability they do not have. `disabledReason` stays for genuine
// unavailability — no data in range, nothing selected.

import { useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import "./DownloadReportButton.scss";

export default function DownloadReportButton({
  onGenerate,
  label = "Download PDF Report",
  disabledReason,
  /** Slug required to see this button at all. */
  permission = "report:export",
}) {
  const { can } = usePermissions();
  const [generating, setGenerating] = useState(false);

  if (permission && !can(permission)) return null;

  const handleClick = async () => {
    // Extra guard against duplicate invocation.
    if (generating || disabledReason) {
      return;
    }

    // Set immediately so the button changes state on the same click.
    setGenerating(true);

    try {
      await onGenerate();
    } catch (error) {
      // Keep the error available to the caller / console while still
      // allowing finally to unlock the button.
      console.error("PDF generation failed:", error);
      throw error;
    } finally {
      // Unlock only after the report process has completed or failed.
      setGenerating(false);
    }
  };

  return (
    <button
      type="button"
      className={`download-report-btn${
        generating
          ? " download-report-btn--generating"
          : ""
      }`}
      onClick={handleClick}
      disabled={
        generating ||
        Boolean(disabledReason)
      }
      aria-busy={generating}
      title={
        disabledReason ||
        (generating
          ? "Generating PDF report…"
          : undefined)
      }
    >
      {generating ? (
        <span
          className="download-report-btn__spinner"
          aria-hidden="true"
        />
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M4 19h16" />
        </svg>
      )}

      <span>
        {generating
          ? "Generating…"
          : label}
      </span>
    </button>
  );
}