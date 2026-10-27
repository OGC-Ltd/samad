// Rebuilds full position frames from the server's `position_delta` events.
//
// The live stream is opened with ?delta=1, so after the replay on connect (full
// `position` frames) the server sends only what changed: one event per batch,
// an array of { vehicleId, ...changed fields, $del?: [fields that vanished] }.
// Bench 2026-10-06: full frames were ~330 KB per viewer per 30 s tick.
//
// applyLiveUpdate still takes a FULL frame — several of its fields are derived
// from the frame as a whole (online, status, onRoad, lastMovedAtMs), so feeding
// it a partial one would read missing speed as "stopped". This keeps the last
// full frame per vehicle and hands back the rebuilt one.
//
// Kept identical in dash/src/lib/positionDelta.js and the server's
// lib/sse.ts positionDelta (the other half of this contract).

export function createFrameStore() {
  const frames = new Map()
  return {
    /** A full `position` frame: remember it as the base, return it unchanged. */
    full(data) {
      if (data?.vehicleId) frames.set(data.vehicleId, data)
      return data
    },
    /** One entry of a `position_delta` array → the rebuilt full frame. */
    apply(delta) {
      const next = { ...(frames.get(delta.vehicleId) ?? {}) }
      for (const [k, v] of Object.entries(delta)) if (k !== '$del') next[k] = v
      for (const k of delta.$del ?? []) delete next[k]
      frames.set(delta.vehicleId, next)
      return next
    },
    clear() { frames.clear() },
  }
}
