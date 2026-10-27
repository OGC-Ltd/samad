# Rai Operations Fleet Dashboard

The web dashboard served at **logistics.raioperations.com**. It shows the live
map, fuel and probe monitoring, route replay, weighbridges, maintenance and
analytics for every organisation on the fleet-server platform.

React + Vite, Redux Toolkit for client state, TanStack Query for server data,
Leaflet with OpenStreetMap for the map, SSE for live updates.

**Contents:** [Quick start](#quick-start) · [How it fits together](#how-it-fits-together) ·
[Configuration](#configuration) · [Scripts](#scripts) · [Code layout](#code-layout) ·
[Deployment](#deployment) · [Troubleshooting](#troubleshooting) · [Further docs](#further-docs)

---

## Quick start

```bash
npm install
npm run dev
```

Opens at `http://localhost:5174` and signs in against the production API, so
use your normal account. The map needs no key; add a `.env` (see
[Configuration](#configuration)) for live traffic.

> **Dev talks to the remote API, on purpose.** `vite.config.js` proxies `/api`
> to the deployed fleet-server in af-south-1, because only that instance runs
> the **poller**. Against a local API every unit reads OFFLINE and a moving
> unit's card says "Parked" beside "ENGINE ON". Never start a second poller
> locally: both would write to the same shared database.

The box has no Elastic IP, so its address changes on every stop/start.
Override it without editing the config:

```bash
VITE_PROXY_TARGET=http://<host> npm run dev
```

Ports are strict: this app 5174, dash 5175, fleet-server 3000. A taken port
fails loudly instead of drifting onto another app.

## How it fits together

**System**

```
Browser (this app)
  │ /api/v1/…        ┌──────────────┐    ┌────────────────────────┐
  ├─────────────────▶│ nginx        ├───▶│ fleet-server :3000     │
  │ SSE /live        │ (TLS, /api)  │    │ poller, queues, rules  │
  ◀──────────────────┤              │◀───┤                        │
  │                  └──────────────┘    └───────────┬────────────┘
  │                                                  ▼
  │                                      PostgreSQL (RDS), Redis
  │
  ├──▶ OpenStreetMap tiles, Nominatim    base map, place search (no key)
  ├──▶ TomTom                            traffic, trip ETAs
  ├──▶ Google Maps                       optional second base map
  └──▶ Open-Meteo                        weather card (no key)
```

**Data inside the app**

```
services/snapshot.js ──▶ GET /vehicles/snapshot ─┐
services/api.js ───────▶ SSE /live?delta=1 ──────┤
                                                 ▼
                     hooks/useFleetLive ──▶ TanStack Query cache ◀── hooks/useApiData (api/*)
                                                 │
store/ (Redux: company, tabs, map, filters) ─────┤
services/cache.js (last snapshot, first paint) ──┤
                                                 ▼
                     context/ selectors ──▶ components/ (map, panels, screens)
```

- **First paint** comes from the last snapshot kept in `localStorage`; the
  fresh snapshot replaces it, then the SSE stream keeps positions current.
- **Server data** lives in TanStack Query (`useApiData` wraps `useQuery`);
  **client state** (active company, tabs, map, filters) lives in Redux.
- **API modules** (`src/api/*`) resolve the organisation, then fetch
  `/api/v1/organisations/:orgId/…`.

## Configuration

Keys are read at build time from `.env` (gitignored; ask for the values, do
not look for them in the repo). Browser map keys ship in the bundle and are
public by design; the domain restriction in each provider's console protects
them.

| Variable | Needed for | Without it |
|---|---|---|
| `VITE_MYTOMTOM_API_KEY` | Live traffic and trip ETAs | Map works, traffic disappears |
| `VITE_GOOGLE_MAPS_API_KEY` | Google as a second base map | OpenStreetMap only |
| `VITE_MAPBOX_API_KEY` | Mapbox base map when `MAPBOX_ENABLED` is on | Unused while the flag is off |
| `VITE_API_URL` | An API on another origin | Same origin `/api` (normal) |
| `VITE_PROXY_TARGET` | Dev only: where `/api` is proxied | The af-south-1 box |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on 5174, API proxied to the box |
| `npm run build` | Production bundle into `build/` |
| `npm run preview` | Serve the built bundle locally |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint |
| `npm run bake:sprites` | Regenerate the vehicle sprite atlases |

## Code layout

| Path | What lives there |
|---|---|
| `src/index.jsx`, `src/App.jsx` | Entry and app shell: tabs, organisation, tab title |
| `src/api/` | One module per backend area |
| `src/services/` | Transport: fetch wrapper, snapshot, first paint cache |
| `src/store/` | Redux Toolkit slices, query client, persistence |
| `src/context/` | Auth, live fleet, map layers, app selectors and actions |
| `src/hooks/` | Data hooks, live fleet, playback, telemetry, cross org lookup |
| `src/lib/` | Pure logic: vehicle state, Leaflet adapter, traffic, filters |
| `src/utils/` | Formatting and report generation |
| `src/data/` | Static config; `companyData.jsx` holds the organisations |
| `src/assets/` | Logos and images |
| `src/components/layout/` | Side panel, header, vehicle detail panel, feeds |
| `src/components/body/` | FleetMap, tool rail, Units panel, playback, sensors |
| `src/components/screens/` | Analytics, Fuel report, Weighbridges, Drivers, Maintenance, Audit, Logbook, admin |
| `src/components/header/`, `footer/` | Company switcher, user menu, stat cards, bottom nav |
| `src/components/mobile/` | Small screen variants |
| `src/components/cards/`, `charts/`, `shared/`, `ui/` | Cards, charts, shared pieces, primitives |

Tests sit beside the code they cover, as `*.test.js` and `*.test.jsx`.

## Deployment

**Every push to `main` deploys to production** via
`.github/workflows/deploy.yml`. There is no staging step.

```
push to main
     │
     ▼
GitHub runner: npm ci ──▶ npm run build ──▶ check public/ in build/ ──▶ write DEPLOYED_COMMIT
     │
     ▼
box: copy live bundle to build.bak-<stamp> (keeps 3) ──▶ rsync into ~/prod/dash/build
     │
     ▼
check: site serves the new hashed entry script
```

The bundle is built on the runner, never on the box: a rebuild in place once
replaced a good bundle with one missing the sprite atlases.

Check what is live:

```bash
curl -s https://logistics.raioperations.com/DEPLOYED_COMMIT
```

Repository secrets (`production` environment): `EC2_SSH_KEY`, `EC2_HOST` and
`EC2_HOST_KEY` reach the box (setup in `fleet-server/docs/ci-deploy.md`;
update `EC2_HOST` when the address changes). `VITE_MYTOMTOM_API_KEY` is
required; `VITE_GOOGLE_MAPS_API_KEY` is optional.

Roll back by copying a backup over the served directory; nginx serves it from
disk, so nothing needs a rebuild or reload:

```bash
ssh -i keys/ustawi.pem ubuntu@<host> 'cd ~/prod/dash && ls -d build.bak-* && cp -r build.bak-<stamp>/. build/'
```

> The served directory is still named `dash` for historical reasons. A push of
> the separate `dash` project to that box would overwrite this site.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every unit OFFLINE, moving units say "Parked" | Dev points at a local API; use the remote proxy target |
| "Invalid email or password" in dev | Proxy points at an old host; check `VITE_PROXY_TARGET` |
| `/api` calls time out in dev | The box's address changed; set `VITE_PROXY_TARGET` |
| No traffic layer, no ETAs | `VITE_MYTOMTOM_API_KEY` missing at build time |
| Page unstyled, no errors anywhere | Vite served empty CSS after a whole file rewrite; touch the CSS file |
| `npm run dev` exits: port in use | Another app holds 5174 |
| A deploy seems not to have landed | Compare `/DEPLOYED_COMMIT` with `git rev-parse origin/main` |

## Further docs

- `fleet-server/README.md`: the API, its data sources and its deploy
- `fleet-server/docs/ci-deploy.md`: deploy secrets and box access
- `fleet-server/docs/af-south-1-deployment.md`: the production box
- `.github/workflows/deploy.yml`: the deploy pipeline, with its reasons inline
