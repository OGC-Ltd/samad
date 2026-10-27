// Control Tech's VSS player SDK (public/vss-sdk), loaded once and adapted to
// run inside this dashboard.
//
// The SDK is four classic scripts that define globals (`VssPlayer`,
// `WebGLPlayer`, `PCMPlayer` and the message constants), plus a Web Worker
// that holds the WebSocket and a WASM decoder. Two of its assumptions only
// hold on VSS's own pages, so they are adjusted from outside rather than by
// editing the vendored files:
//
//   · It starts its worker as `new Worker("./js/hwwebsocket.js")`, relative to
//     the PAGE. Here that would resolve against whatever route is open. The
//     Worker constructor is swapped for the duration of that one call so the
//     path points into /vss-sdk/.
//   · It builds the stream URL from the page's own host. `wsUrl` is replaced
//     to return the URL the server gave (fleet-server modules/camera), passed
//     in as the `ip` argument of `live()`.
//
// It also gains `lastFrameAt`, because the SDK reports "playing" once, on the
// first frame, and says nothing when frames stop: a stream that drops would
// otherwise sit on its last picture looking live.

const SDK = `${import.meta.env.BASE_URL}vss-sdk/`;
const PAGE_SCRIPTS = ["common.js", "webgl.js", "pcm-player.js", "vss-player.js"];
const SDK_WORKER = "./js/hwwebsocket.js";

let ready = null;

/** One <script> per file, ever: the SDK's top-level `const`s cannot run twice. */
const scripts = new Map();
function addScript(src) {
  if (!scripts.has(src)) {
    const p = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = () => resolve();
      el.onerror = () => { el.remove(); reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(el);
    });
    // A file that failed to arrive never ran, so it may be asked for again.
    p.catch(() => scripts.delete(src));
    scripts.set(src, p);
  }
  return scripts.get(src);
}

function adapt(Player) {
  const P = Player.prototype;
  if (P.adaptedForDashboard) return Player;
  P.adaptedForDashboard = true;
  const initSocketWorker = P.initSocketWorker;
  P.initSocketWorker = function () {
    const NativeWorker = window.Worker;
    window.Worker = function (url, opts) {
      return new NativeWorker(url === SDK_WORKER ? `${SDK}hwwebsocket.js` : url, opts);
    };
    try { return initSocketWorker.call(this); } finally { window.Worker = NativeWorker; }
  };
  P.wsUrl = function (url) { return url; };
  const onVideoFrame = P.onVideoFrame;
  P.onVideoFrame = function (frame) {
    this.lastFrameAt = Date.now();
    return onVideoFrame.call(this, frame);
  };
  return Player;
}

/** Resolves to the adapted `VssPlayer` constructor. Loads the SDK the first time only. */
export function loadVssPlayer() {
  if (!ready) {
    ready = PAGE_SCRIPTS
      .reduce((p, f) => p.then(() => addScript(SDK + f)), Promise.resolve())
      .then(() => {
        if (typeof window.VssPlayer !== "function") throw new Error("VSS player SDK did not load");
        return adapt(window.VssPlayer);
      });
    // Failed (offline, a deploy mid-flight): the next open tries again, and
    // addScript fetches only the files that did not arrive.
    ready.catch(() => { ready = null; });
  }
  return ready;
}
