// The foot of a Live Feed list: loading older, the end of the day, or a button.
// With `nearBottom`, the scroll handler every feed list uses to page further.

import "./FeedFooter.css";

/** Call `loadMore` once the list is within a screen of its bottom. */
export function nearBottom(loadMore) {
  return (e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) loadMore();
  };
}

export default function FeedFooter({ count, loadingMore, atEnd, loadMore, allDays = false }) {
  if (!count) return null;
  return (
    <div className="feed-foot">
      {loadingMore
        ? "Loading older activity…"
        : atEnd
          ? `That is everything logged${allDays ? "" : " today"} · ${count.toLocaleString()} update${count === 1 ? "" : "s"}.`
          : <button type="button" className="feed-foot__btn" onClick={loadMore}>Load older</button>}
    </div>
  );
}
