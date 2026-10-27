// Run `fn` over `items` at most `limit` at a time, results in order and shaped
// as Promise.allSettled gives them.
//
// The vehicle panel's date picker reaches back 90 days (operator, 28 Sep: "the
// date picker should allow us to pick even more than 30 days in a range"), and
// each day is its own request. Sent all at once, a 90-day pick would put 90
// telemetry queries on the server in the same moment; a few at a time keeps a
// long range from crowding out the live map.

export async function settleLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
