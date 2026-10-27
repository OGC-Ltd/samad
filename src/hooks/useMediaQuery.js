import { useState, useEffect } from "react";

// Subscribe to a media query from JS. For the cases where a breakpoint has to
// change BEHAVIOUR and not just layout — a page size, a column count, whether a
// chart renders at all — and CSS cannot reach it.
//
// Read once in the state initialiser rather than in an effect, so the first
// paint is already correct: starting false and correcting on mount renders the
// wide layout for a frame on every phone.
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    // Re-read on subscribe: the query can have changed between the initialiser
    // and this effect (a rotation during hydration, or a changed `query`).
    setMatches(mq.matches);
    if (!mq.addEventListener) return undefined;
    const onChange = (e) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export default useMediaQuery;
