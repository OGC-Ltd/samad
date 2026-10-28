// MobileLiveFeedSheet — mirrors React Native LiveFeedSheet exactly.
// The whole fleet day, continuous, as in the desktop panel (hooks/useVehicleFeed).

import { useFleetLiveShared } from '../../context/FleetLiveContext';
import FeedText from '../shared/FeedText';
import { feedClock, feedDate } from '../../lib/feedTime';
import { feedItemFollowUp, openFollowUp } from '../../lib/fuelFollowUps';
import { useVehicleFeed } from '../../hooks/useVehicleFeed';
import { usePermissions } from '../../hooks/usePermissions';
import FeedFooter, { nearBottom } from '../shared/FeedFooter';
import './MobileLiveFeedSheet.scss';

const ALERT_TYPES = new Set(['warning', 'critical']);

function dotColor(type) {
  if (type === 'critical') return '#f43f5e';
  if (type === 'warning')  return '#f59e0b';
  if (type === 'success')  return '#10b981';
  return '#94a3b8';
}

export default function MobileLiveFeedSheet({ open, onClose }) {
  const { feed: liveFeed = [], orgId } = useFleetLiveShared();
  const { flaggedOnly } = usePermissions();
  const { items: feed, loading, loadingMore, atEnd, loadMore } = useVehicleFeed(null, open ? orgId : null, liveFeed, null, { allDays: flaggedOnly });
  const unread = feed.filter(f => ALERT_TYPES.has(f.type)).length;

  return (
    <>
      {open && <div className="mlf-backdrop" onClick={onClose} />}
      <div className={`mlf-sheet${open ? ' mlf-sheet--open' : ''}`}>
        <div className="mlf-handle" />

        <div className="mlf-header">
          <div className="mlf-header-left">
            <span className="mlf-title">LIVE FEED</span>
            <span className="mlf-dot" />
          </div>
          <div className="mlf-header-right">
            {unread > 0 && <span className="mlf-unread">{unread} alert{unread > 1 ? 's' : ''}</span>}
            <button className="mlf-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="mlf-list" onScroll={nearBottom(loadMore)}>
          {feed.length === 0 && (
            <div className="mlf-empty">{loading ? 'Loading activity…' : 'No recent activity'}</div>
          )}
          {feed.map((item, i) => {
            // A follow-up item opens its case window (over this sheet).
            const followUp = feedItemFollowUp(item);
            const opens = typeof followUp === 'string';
            return (
            <div
              key={item.id ?? i}
              className={`mlf-row${opens ? ' mlf-row--action' : ''}`}
              role={opens ? 'button' : undefined}
              tabIndex={opens ? 0 : undefined}
              onClick={opens ? () => { onClose?.(); openFollowUp(followUp); } : undefined}
            >
              <div className="mlf-time-col">
                <span className="mlf-date">{feedDate(item)}</span>
                <span className="mlf-time">{feedClock(item)}</span>
              </div>
              <span className="mlf-kind-dot" style={{ background: dotColor(item.type) }} />
              <div className="mlf-body">
                <span className="mlf-plate">{item.plate ?? 'Fleet'}</span>
                <span className="mlf-msg"><FeedText text={item.text} type={item.type} plate={item.plate} /></span>
              </div>
            </div>
            );
          })}
          <FeedFooter count={feed.length} loadingMore={loadingMore} atEnd={atEnd} loadMore={loadMore} allDays={flaggedOnly} />
        </div>
      </div>
    </>
  );
}
