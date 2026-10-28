# Observability: Prometheus, Grafana, Jaeger

Samad's metrics, system checks and request traces, viewed outside the app.

| Piece | What it does | Reached at |
| --- | --- | --- |
| Samad `/metrics` | Requests by route and status, response times, calls to the Partner API / Google / OpenAI / cameras, partner poll times, CPU, memory, disk, goroutines (`server/metrics.go`, `server/system.go`) | inside the box only, with `METRICS_TOKEN` |
| Samad traces | One span per request, a child span per outside call (`server/tracing.go`), sent over OTLP | — |
| Prometheus | Scrapes `/metrics` every 15 s, keeps 15 days (1 GB cap), runs the system checks in `prometheus/rules.yml` | `ssh -L 9090:127.0.0.1:9090 box` → http://localhost:9090 |
| Grafana | The **Samad · Overview** dashboard (`grafana/dashboards/samad.json`), and Explore over Prometheus and Jaeger | **https://SAMAD_DOMAIN/grafana** (sign in as `admin`) |
| Jaeger | Stores traces in memory (lost on restart) | through Grafana › Explore › Jaeger, or `ssh -L 16686:127.0.0.1:16686 box` → http://localhost:16686 |

It is its own compose project, like `deploy/traefik`, and is not part of a Samad
release: CI never touches it. It joins the shared `proxy` network, which is how
Prometheus reaches `samad:8080` and Samad reaches `jaeger:4318`. Samad runs the
same with this stack down (it serves `/metrics` to nobody, and trace export
fails quietly).

## Set up (once, on the box)

```sh
sudo mkdir -p /opt/observability/secrets
# copy this folder's files to /opt/observability, then:
cd /opt/observability
echo "SAMAD_DOMAIN=$(sudo sed -n 's/^SAMAD_DOMAIN=//p' /opt/samad/.env)" | sudo tee .env

# The scrape token, shared with Samad. Readable by Prometheus (uid 65534) only.
openssl rand -hex 32 | sudo tee secrets/metrics-token >/dev/null
sudo chown 65534 secrets/metrics-token && sudo chmod 400 secrets/metrics-token
# Grafana's admin password. Readable by Grafana (uid 472) only.
openssl rand -base64 24 | tr -d '\n' | sudo tee secrets/grafana-admin-password >/dev/null
sudo chown 472 secrets/grafana-admin-password && sudo chmod 400 secrets/grafana-admin-password

# Samad: serve /metrics to that token, and send traces to Jaeger.
printf 'METRICS_TOKEN=%s\nOTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318\nOTEL_SERVICE_NAME=samad-server\n' \
  "$(sudo cat secrets/metrics-token)" | sudo tee -a /opt/samad/server/.env >/dev/null

sudo docker compose up -d
```

Samad reads its `.env` when its container is created, so the next deploy picks
the two settings up (or `cd /opt/samad && sudo docker compose up -d --force-recreate samad`).

Grafana's admin password: `sudo cat /opt/observability/secrets/grafana-admin-password`.
Change it under Grafana › Profile after the first sign-in, and add people as
Viewers under Administration › Users rather than sharing the admin account.

## The system checks

`prometheus/rules.yml`: Samad unreachable, partner feed stale (5 min) or down
(15 min), 5xx over 5 %, p95 over 3 s, an outside service failing over 20 % of
calls, memory over 85 % of its limit, CPU saturated, disk under 10 % / 5 %, data
folder not writable. Firing ones show at the top of the dashboard. Nothing is
sent anywhere yet: add an Alertmanager or a Grafana contact point to be paged.

## Changing things

- Dashboard: edit `grafana/dashboards/samad.json` (Grafana does not save UI edits
  back), copy it up, and Grafana reloads it within a minute.
- Rules or scrape config: copy them up, then
  `curl -X POST http://127.0.0.1:9090/-/reload` on the box.
- Fewer traces: `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and
  `OTEL_TRACES_SAMPLER_ARG=0.2` in Samad's `server/.env`.

## Cost on the box

Memory caps: Prometheus 320 MB, Grafana 256 MB, Jaeger 384 MB (each uses far
less at Samad's traffic). Disk: the three images, about 1 GB, plus Prometheus'
1 GB cap.
