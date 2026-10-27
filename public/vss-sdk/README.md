# VSS player SDK (vendored)

Control Tech's VSS "player for self-defined UI" SDK (VSS Web API v2.8.0, §6.2),
copied byte-for-byte from `https://vss.controltech-ea.com/vss/js/` on 2026-10-22
(the files carry `?v=1.6.0`; the server's pages are 1.8.6). Used by
`src/lib/vssPlayer.js` for the live camera in the unit card.

Why it is copied here instead of loaded from VSS: the SDK decodes in a Web
Worker, and a browser only starts workers from the page's own origin. Serving
the files from this site is the only way to run it.

| file | role |
| --- | --- |
| `common.js` | message constants, page and worker |
| `webgl.js`, `pcm-player.js` | YUV rendering and audio, page |
| `vss-player.js` | `VssPlayer`, page |
| `hwwebsocket.js` | stream worker: WebSocket + decoding |
| `decoder.js`, `libdecoder.js`, `libdecoder.wasm` | the FFmpeg/WASM decoder the worker loads |

Not edited. Two methods are overridden from outside (see `src/lib/vssPlayer.js`):
the worker path, which the SDK hard-codes relative to the page, and the stream
URL, which it otherwise derives from the page's own host.

If VSS is upgraded and live video stops, re-copy all eight files from the
server, together.
