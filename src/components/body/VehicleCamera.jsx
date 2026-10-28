// The unit's dashcam, live, as a window over the map.
//
// ## Where the video comes from
//
// Control Tech's VSS platform. fleet-server (modules/camera) finds the VSS
// device whose name matches this unit's plate, asks VSS whether it is
// connected, and answers with its channels (on this fleet the road and the
// cab) and the media server to stream from. The VSS account and its token stay
// on the server.
//
// The picture is drawn here by VSS's own player SDK (public/vss-sdk, adapted
// in lib/vssPlayer): a WebSocket to the media server, decoded in a worker and
// painted on a canvas per channel. VSS's ready-made player PAGE cannot be used
// instead — it refuses to open inside another site (X-Frame-Options).
//
// ## Controls
//
// Window: which channels to show, SD or HD, reconnect. Each channel: sound,
// stop/play, full screen.
//
// Every state that is not video is a sentence, never a spinner left running
// or a black rectangle: both read as a broken feed and send someone to check
// a vehicle that may have no camera at all. A stream that never delivers a
// picture, or stops delivering one, says so after STALL_MS.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { useFloatingWindow } from "../../hooks/useFloatingWindow";
import { getVehicleCamera, channelLabel } from "../../api/vehicleCamera";
import { loadVssPlayer } from "../../lib/vssPlayer";
import "./VehicleCamera.scss";

/** No first picture, or no new one, for this long reads as "no picture". */
const STALL_MS = 15_000;
/** Buffer the SDK holds before painting; VSS's own pages use 2000. */
const BUFFER_MS = 2000;

/** What to say for each answer that is not a playing feed. */
const EMPTY = {
  no_camera:      "No camera on this unit",
  offline:        "Camera offline",
  not_configured: "Camera service not set up",
  unavailable:    "Camera service not answering",
};

const STATUS_TEXT = {
  connecting: "Connecting",
  live:       "Live",
  stopped:    "Stopped",
  stalled:    "No picture",
  failed:     "Player failed",
};

function Empty({ head, note }) {
  return (
    <div className="vcam__stage">
      <div className="vcam__empty">
        <span className="vcam__empty-icon" aria-hidden="true">◎</span>
        <p className="vcam__empty-head">{head}</p>
        {note && <p className="vcam__empty-note">{note}</p>}
      </div>
    </div>
  );
}

/** One channel: its canvas, its own player, its own controls. */
function LiveChannel({ streamUrl, deviceId, channel, quality, generation }) {
  const domId = `vcam-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const tileRef = useRef(null);
  const playerRef = useRef(null);
  const [running, setRunning] = useState(true);
  const [status, setStatus] = useState("connecting");
  const [sound, setSound] = useState(false);

  useEffect(() => {
    if (!running) { setStatus("stopped"); return undefined; }
    let cancelled = false;
    let player = null;
    let startedAt = Date.now();
    setStatus("connecting");
    setSound(false);

    loadVssPlayer().then((VssPlayer) => {
      if (cancelled) return;
      player = new VssPlayer(`#${domId}`, ({ status: s }) => {
        if (!cancelled && s === "playing") setStatus("live");
      });
      playerRef.current = player;
      startedAt = Date.now();
      player.live(streamUrl, 0, deviceId, channel.no, quality, false, BUFFER_MS);
    }).catch(() => { if (!cancelled) setStatus("failed"); });

    // The SDK never reports a stream that ends or never starts; judge by frames.
    const watch = setInterval(() => {
      if (!player) return;
      const last = player.lastFrameAt ?? startedAt;
      if (Date.now() - last > STALL_MS) setStatus("stalled");
      else if (player.lastFrameAt) setStatus("live");
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(watch);
      playerRef.current = null;
      // stop() also tears down the worker, and throws if it never got one.
      try { player?.stop(); } catch { /* never started */ }
    };
  }, [running, streamUrl, deviceId, channel.no, quality, generation, domId]);

  // In the click itself, not an effect: browsers only start audio from a gesture.
  const toggleSound = () => {
    const next = !sound;
    playerRef.current?.openAudio(next);
    setSound(next);
  };

  const fullscreen = () => {
    const el = tileRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  };

  const name = channelLabel(channel.name);
  return (
    <figure ref={tileRef} className={`vcam__feed vcam__feed--${status}`}>
      <div id={domId} className="vcam__canvas" />
      {status !== "live" && (
        <div className="vcam__feed-note">
          {status === "connecting" && "Connecting to the camera"}
          {status === "stopped" && "Stopped"}
          {status === "stalled" && "No picture from this camera"}
          {status === "failed" && "The video player could not start"}
        </div>
      )}
      <figcaption className="vcam__caption">
        <span className={`vcam__dot vcam__dot--${status}`} aria-hidden="true" />
        {name}
        <span className="vcam__status">{STATUS_TEXT[status]}</span>
      </figcaption>
      <div className="vcam__tools">
        <button type="button" className="vcam__tool" onClick={toggleSound} disabled={!running}
          aria-pressed={sound} aria-label={sound ? `Mute ${name}` : `Sound on ${name}`} title={sound ? "Mute" : "Sound on"}>
          {sound ? "🔊" : "🔇"}
        </button>
        <button type="button" className="vcam__tool" onClick={() => setRunning(r => !r)}
          aria-label={running ? `Stop ${name}` : `Play ${name}`} title={running ? "Stop" : "Play"}>
          {running ? "■" : "▶"}
        </button>
        <button type="button" className="vcam__tool" onClick={fullscreen}
          aria-label={`Full screen ${name}`} title="Full screen">⛶</button>
      </div>
    </figure>
  );
}

export default function VehicleCamera({ vehicle, onClose }) {
  const { ref, onPointerDown } = useFloatingWindow({
    id: "vehicle-camera",
    dock: "bottom-right",
  });
  const { orgId } = useFleetLiveShared();
  const dbId = vehicle?.vehicleId ?? null;
  /** Channel numbers hidden by the operator. */
  const [hidden, setHidden] = useState(() => new Set());
  /** 0 = sub-stream (SD, lighter on the truck's data), 1 = main (HD). */
  const [quality, setQuality] = useState(0);
  /** Bumped by Reconnect: every channel tears down and dials again. */
  const [generation, setGeneration] = useState(0);

  const q = useQuery({
    queryKey: ["vehicle-camera", orgId, dbId],
    queryFn: ({ signal }) => getVehicleCamera(orgId, dbId, { signal }),
    enabled: orgId != null && dbId != null,
    // The online state is read from VSS on each open; never reuse an old one.
    staleTime: 0,
    gcTime: 0,
    // Once, and never on a 4xx: those answers will not change on a retry.
    retry: (n, err) => n < 1 && !(err?.status >= 400 && err?.status < 500),
    refetchOnWindowFocus: false,
  });
  const cam = q.data;
  const live = cam?.state === "live" && cam.streamUrl;

  const toggleChannel = useCallback((no) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(no)) next.delete(no);
      // Never hide the last one: an empty window looks like a fault.
      else if (cam && next.size < cam.channels.length - 1) next.add(no);
      return next;
    });
  }, [cam]);

  const reconnect = () => { setGeneration(g => g + 1); q.refetch(); };

  let body;
  if (dbId == null) {
    body = <Empty head={EMPTY.no_camera} />;
  } else if (q.isPending) {
    body = <Empty head="Looking for this unit's camera" />;
  } else if (q.isError) {
    // A 404 is a server without the camera route yet (not deployed), which is
    // a different fault from VSS being down.
    body = q.error?.status === 404
      ? <Empty head={EMPTY.not_configured} note="This server does not offer camera feeds yet." />
      : <Empty head={EMPTY.unavailable} note="Try again in a minute." />;
  } else if (!live) {
    const note = cam.state === "offline"
      ? `${cam.deviceName ?? "The camera"} is not connected to the video server.`
      : cam.message;
    body = <Empty head={EMPTY[cam.state] ?? EMPTY.unavailable} note={note} />;
  } else {
    const shown = cam.channels.filter(c => !hidden.has(c.no));
    body = (
      <>
        <div className="vcam__controls">
          {cam.channels.length > 1 && (
            <div className="vcam__seg" role="group" aria-label="Channels">
              {cam.channels.map(c => (
                <button key={c.no} type="button" className="vcam__seg-btn" aria-pressed={!hidden.has(c.no)}
                  onClick={() => toggleChannel(c.no)}>{channelLabel(c.name)}</button>
              ))}
            </div>
          )}
          <div className="vcam__seg" role="group" aria-label="Picture quality">
            <button type="button" className="vcam__seg-btn" aria-pressed={quality === 0} onClick={() => setQuality(0)}
              title="Sub-stream: lighter on the truck's data">SD</button>
            <button type="button" className="vcam__seg-btn" aria-pressed={quality === 1} onClick={() => setQuality(1)}
              title="Main stream: full resolution">HD</button>
          </div>
        </div>
        <div className={`vcam__grid${shown.length > 1 ? " vcam__grid--two" : ""}`}>
          {shown.map(c => (
            <LiveChannel key={c.no} streamUrl={cam.streamUrl} deviceId={cam.deviceId}
              channel={c} quality={quality} generation={generation} />
          ))}
        </div>
      </>
    );
  }

  return (
    <div ref={ref} className={`vcam${live ? " vcam--live" : ""}`}>
      <div className="vcam__bar" onPointerDown={onPointerDown} title="Hold and drag to move">
        <span className="vcam__grip" aria-hidden="true">⠿</span>
        <span className="vcam__plate">{vehicle?.id} · camera</span>
        {cam && cam.state !== "no_camera" && (
          <button type="button" className="vt-action" onClick={reconnect} aria-label="Reconnect camera" title="Reconnect">↻</button>
        )}
        <button type="button" className="vt-action" onClick={onClose} aria-label="Close camera" title="Close">✕</button>
      </div>
      {body}
    </div>
  );
}
