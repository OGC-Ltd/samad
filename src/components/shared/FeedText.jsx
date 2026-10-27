// One Live Feed line, rendered.
//
// The sentence is read by lib/feedMessage first — the account prefix, the
// placeholders and the shouted names come off there, and the severity word
// comes out of the sentence and back as a badge. Everything this file decides
// is how the badge looks.
//
// It is tinted by the ITEM'S type rather than by the word in it, so the badge
// and the icon beside it can never disagree: "RESTRICTED" is red because the
// event is critical, not because the word sounds severe.

import { formatFeedText } from "../../lib/feedMessage";

const BADGE_CLS = {
  critical: "feed-badge--critical",
  warning:  "feed-badge--warning",
  success:  "feed-badge--success",
  info:     "feed-badge--info",
};

export default function FeedText({ text, type, plate, driver }) {
  const { badge, body } = formatFeedText(text, { plate, driver });
  if (!badge) return <>{body}</>;
  return (
    <>
      <span className={`feed-badge ${BADGE_CLS[type] ?? BADGE_CLS.warning}`}>{badge}</span>{" "}
      {body}
    </>
  );
}
