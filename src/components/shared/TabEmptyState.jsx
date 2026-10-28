// Shared tab empty state — icon + title + hint, centred in the tab panel.
// Used by the Weighbridges, Drivers, Maintenance and Analytics screens when
// there is no data yet (the DB starts empty until the RaiFactorySuite live
// integration lands).

import "./TabEmptyState.scss";

// `action` is for the one case where the state is not merely empty but STUCK —
// an organisation this account can open no screen in. An empty tab is
// something to read and move on from; a locked one needs a way out in it,
// because the nav that would normally be the way out is what is switched off.
export default function TabEmptyState({ icon, title, hint, action }) {
  return (
    <div className="tab-empty">
      <div className="tab-empty__box">
        <span className="tab-empty__icon">{icon}</span>
        <h2 className="tab-empty__title">{title}</h2>
        <p className="tab-empty__hint">{hint}</p>
        {action && <div className="tab-empty__action">{action}</div>}
      </div>
    </div>
  );
}
