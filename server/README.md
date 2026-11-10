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

## Deploy (Docker, behind Traefik)

The repo root has a `Dockerfile` (the built dashboard and this server in one
distroless image, run as a non-root user) and a `docker-compose.yml` with
three services:

| Service | Image | Networks | Notes |
| --- | --- | --- | --- |
| `samad` | built here | `proxy`, `samad-db` | no published port; Traefik routes `SAMAD_DOMAIN` to it on 443 |
| `db` | `postgis/postgis:18-3.6` | `samad-db` (internal) | volume `samad-pgdata`; password from `secrets/postgres_password` |
| `migrate` | `migrate/migrate:v4.20.1` | `samad-db` | applies `server/migrations`, then exits; the app starts after it |

On the box (`/opt/samad`), with `server/.env`, `secrets/postgres_password` and
`SAMAD_DOMAIN` in `.env` beside the compose file:

```bash
docker compose up -d --build
docker compose run --rm migrate version      # which migration the database is on
docker compose exec db psql -U samad samad   # a SQL prompt
```

## Migrations

[golang-migrate](https://github.com/golang-migrate/migrate) files in
`migrations/`, one numbered `up`/`down` pair per step. A new step:

```bash
docker run --rm -v "$PWD/migrations:/migrations" migrate/migrate:v4.20.1 create -ext sql -dir /migrations -seq <name>
```

The schema is in place; the server still keeps its state in `data/state.json`
until its store is moved onto it.

## What it does

| Partner API | Polled | Serves |
| --- | --- | --- |
| `/partner/v1/positions` | every 30 s | `/vehicles/snapshot`, the `/live` stream, the drivers' daily km and trips, driver hours (the bell) |
| `/partner/v1/events` (cursor) | every 30 s | `/alerts*`: every event, as overspeeding, camera or other (platform), beside the driver-hours breaches |
| `/partner/v1/vehicles`, `/geofences` | daily | unit names and drivers, `/geofences/geojson` |
| `/partner/v1/vehicles/{id}/positions` | on demand | `/track`, `/playback`, and a 7-day backfill on first start |

Requests to the partner are spaced 600 ms apart, under its 120/min and 30/10 s
limits. Received alarms, the feed cursor, read marks, decisions and the daily
tallies are kept in `data/state.json` (30 days).

### Driver hours (`hours.go`)

The notification bell (the `/live` stream's `feed` frames) carries one thing:
breaches of the client's working time rules, checked on every position read.
Working is the engine on or the vehicle moving; driving is the engine on at
1 km/h or more; rest is everything else, including a parked tracker's silence
(a gap over 5 minutes counts 5 minutes in the state it began in).

| Rule | Breach |
| --- | --- |
| Working hours | over 8 h a day or 48 h a week |
| Overtime | over 12 h a day or 60 h a week |
| Breaks | 4.5 h of driving without a 30 min stop |
| Daily rest | a 24 h duty window with no 11 h rest in one piece |
| Weekly rest | a Monday-to-Sunday week that can no longer hold 24 h of rest |
| Driving time | over 9 h a day or 48 h a week |

Each breach is sent once per vehicle and period, and names the vehicle's driver.
Hours are kept per vehicle from the first live read (no history is replayed),
so a week that began before the server did is not judged on weekly rest.
Breaches are stored apart from the partner's events (`hours` in
`state.json`), so the reports never count them; the Alerts page lists them too,
as the Driver hours kind, to be escalated or de-escalated like any alert.

### Reports (`report_*.go`)

The Reports page's five reports (Policy Breaches, Driver Conduct, Movements,
End of Shift, Weekly Incidents) are built and drawn here, not in the browser:

| Route | What it does |
| --- | --- |
| `GET /reports/{breaches,conduct,movements,shift}/document` | builds the report as an editable document (plain text: headings, figures, tables, notes) |
| `GET /reports/weekly/document?weeks=N` | the last N finished weeks (1 to 12), Monday to Sunday |
| `POST /reports/render?format=pdf\|jpeg\|csv\|preview` | draws a document, as built or as edited, in portrait or landscape |

One layout (`report_layout.go`, A4 in millimetres, the Go fonts and the two
logos embedded) feeds the PDF (`go-pdf/fpdf`), the JPEG and preview pages
(`x/image`) alike. A long JPEG comes as several sheets (`X-Sheets`, `?sheet=`).
Movements and End of Shift read each unit's trip history (cached per unit-day;
a cold month takes a while at the partner's pace) and a place name from the
Google Geocoding API with the server's key: without that API enabled on the
key, current locations fall back to zones and coordinates (logged once).

End of Shift follows the Menengai end-of-shift sheet (landscape): overview,
critical alarms, the breaches as a strip of counts and the top five units for
each, and the handover with lines and two signatures. `shift=custom&from=&to=`
takes a period picked by hand instead of a day and shift.

Driver Conduct follows the Menengai Driver Conduct sheet: each vehicle's
harsh acceleration, harsh braking, no seatbelt, on phone and camera covered,
one table per vehicle type, then the roster trucks IntelliFleet does not
report. Overspeeding stays in Policy Breaches.

Weekly Incidents counts the policy breaches per driver and per truck, week by
week. Events are kept 30 days, so the daily prune also keeps each finished
week as a small tally (`weeks` in `state.json`, two years) that outlives
them: km and incidents per truck, and per driver. An incident goes to the
driver the truck had that day (the day tally's driver), not today's.

Routes the dashboard calls for features Samad does not have yet (fuel,
repairs, weighbridges, routing) answer an empty list.

## Known gaps

- The partner's `/trips` and `/stoppages` are not enabled for this key (403),
  so trips and distance are worked out from positions.
- The partner does not say what speed limit its `over_speeding` uses; set
  `SPEED_LIMIT_KMH` to match (default 65).
- Accounts and roles (`users.go`, `roles.go`) are a JSON file in `DATA_DIR`,
  not yet the database; roles are code, with no role editor.
- Email covers invitations and password resets only (`mail.go`, Mailtrap SMTP);
  without `MAIL_TRAP` the set-password link goes to the administrator.
- No dispatches: the road ahead runs only to a point picked on the map.
