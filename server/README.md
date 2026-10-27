# samad-server

The API behind the Samad Resources fleet dashboard (the React app one folder
up). It reads the fleet from the IntelliFleet360 Partner API and serves it in
the shapes the dashboard expects. Go, gorilla/mux.

## Run

```bash
cp .env.example .env   # then fill in the key, a JWT secret and the sign-in
go run . hash-password '<password>'   # prints ADMIN_PASSWORD_HASH
go run .
```

The dashboard's dev server (`npm run dev` in the parent folder) proxies `/api`
to `http://localhost:8080`.

## What it does

| Partner API | Polled | Serves |
| --- | --- | --- |
| `/partner/v1/positions` | every 30 s | `/vehicles/snapshot`, the `/live` stream, the drivers' daily km and trips |
| `/partner/v1/events` (cursor) | every 30 s | `/alerts*` (overspeeds and camera alarms), the live feed (every event) |
| `/partner/v1/vehicles`, `/geofences` | daily | unit names and drivers, `/geofences/geojson` |
| `/partner/v1/vehicles/{id}/positions` | on demand | `/track`, `/playback`, and a 7-day backfill on first start |

Requests to the partner are spaced 600 ms apart, under its 120/min and 30/10 s
limits. Received alarms, the feed cursor, read marks, decisions and the daily
tallies are kept in `data/state.json` (30 days).

Routes the dashboard calls for features Samad does not have yet (fuel,
repairs, weighbridges, routing) answer an empty list.

## Known gaps

- The partner's `/trips` and `/stoppages` are not enabled for this key (403),
  so trips and distance are worked out from positions.
- The partner does not say what speed limit its `over_speeding` uses; set
  `SPEED_LIMIT_KMH` to match (default 65).
- One sign-in account, from `.env`.
