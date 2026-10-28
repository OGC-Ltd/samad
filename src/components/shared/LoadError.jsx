// Inline 'failed to load, Retry' UI for failed data fetches.

import "./ErrorBoundary.scss";

export default function LoadError({ label, onRetry, fullSection = false, message }) {
  return (
    <div className={`error-boundary${fullSection ? " error-boundary--full" : " error-boundary--compact"}`}>
      <span className="error-boundary__icon">⚠</span>
      <div className="error-boundary__text">
        <p className="error-boundary__title">
          {label ? `${label} failed to load` : "Something went wrong"}
        </p>
        <p className="error-boundary__subtitle">
          {message || "Check your connection and try again."}
        </p>
      </div>
      <button className="error-boundary__retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
