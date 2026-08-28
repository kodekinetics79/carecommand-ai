# Observability & SLOs

How CareCommand knows it's breaking **before the customer does** — the three
pillars (logs, metrics, traces) correlated on one id, health probes, durable
error capture, and the SLOs the alerts fire against.

> **TL;DR wiring**
> - Traces: `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` → distributed traces across API → job → worker, all sharing one `trace_id`. Span URLs are scrubbed (tokens/ids/queries) before export.
> - Metrics: **two scrape targets.** The API serves request/dependency/queue metrics at `/metrics`; the **worker serves job outcomes** (`jobs_total`, `job_duration_seconds`) on its own listener at `:9464` (`WORKER_METRICS_PORT`) — registries are per-process, so scraping only the API leaves the job SLO blind. Both protected by `METRICS_TOKEN` in prod.
> - Errors: `SENTRY_DSN` + `npm i @sentry/node` → durable capture. Without it, still structured `event:"exception"` logs.
> - Logs: structured, PHI-redacted, stamped with `trace_id`/`span_id`.
> - SLOs: `server/lib/slo.ts` (source of truth) → `ops/prometheus/alerts.yml` (alerts) → `GET /health/slo` (discoverable).

---

## The three pillars, correlated

| Pillar | Where | Correlation id |
|---|---|---|
| **Logs** | pino, structured JSON, PHI/secret-redacted ([config/logger.ts](../server/config/logger.ts)) | `trace_id` + `span_id` stamped via mixin; `requestId` per request |
| **Metrics** | `prom-client`: API at `/metrics`, worker at `:9464` ([lib/metrics.ts](../server/lib/metrics.ts), [workers/metricsServer.ts](../server/workers/metricsServer.ts)) | labels by route template (no ids/PHI) |
| **Traces** | OpenTelemetry, OTLP/HTTP export ([lib/tracing.ts](../server/lib/tracing.ts)); URL attributes scrubbed of tokens/ids/queries before export ([lib/spanRedaction.ts](../server/lib/spanRedaction.ts)) | `trace_id` propagated HTTP → BullMQ job → worker |

**The join:** one `trace_id` flows from an inbound HTTP request, into any BullMQ
job it enqueues (carried in the job payload as `_otel`, see
[lib/traceContext.ts](../server/lib/traceContext.ts)), through the worker that
processes it — and is stamped onto every log line along the way. Given a
`trace_id` (or the `requestId` returned in any 5xx error body) you can pull the
full story: the trace waterfall, every correlated log, and the error in Sentry.

---

## Answering the four questions

### 1. If the app goes down, how do we find out?

- **External uptime monitor → `/health/ready`.** This probe actually checks
  Postgres (`SELECT 1`) and Redis (`PING`) and returns **503** if either is
  down. Point Better Stack / Pingdom / UptimeRobot at it and enable paging.
- **Prometheus `ApiTargetDown`/`WorkerTargetDown`** fire when a process stops
  being scraped at all.
- **`DependencyDown`** fires when Postgres/Redis probes fail. The
  `dependency_up` gauge is refreshed by **both** `/health/ready` and every
  `/metrics` scrape, so it stays live even with no external monitor polling.

> ⚠️ **Render free-plan idle spindown.** The web service (`render.yaml`, `plan:
> free`) spins down when idle, so the first request after idle is slow and an
> uptime monitor may flag a false "down". Mitigation: upgrade the web plan to
> `starter`, **or** set the uptime monitor interval ≤ the spindown window so the
> service is kept warm, **or** treat single-sample failures as non-paging and
> alert only on 2+ consecutive failures.

### 2. If something fails, can we trace it in 60 seconds?

Yes. Every 5xx returns a `requestId` in its body. With tracing on, logs carry
`trace_id`. Flow: grab the id from the error/customer → search logs → open the
trace → see exactly which span (DB query, Redis call, downstream, worker job)
failed. With Sentry on, the exception is already grouped with that context
attached. **Cross-service** failures (a worker job that a request kicked off)
share the same `trace_id`, so the API span and the worker span sit in one trace.

### 3. Are the three pillars connected? Does OpenTelemetry fix it?

Yes — that's exactly what OTel does here. Auto-instrumentation covers Fastify,
HTTP, `pg`, and `ioredis`; W3C context propagation carries the trace across the
Redis/job boundary; and the pino mixin stamps `trace_id` onto logs. One id joins
all three.

### 4. Do we have SLOs?

Yes — [server/lib/slo.ts](../server/lib/slo.ts) is the source of truth, served
at `GET /health/slo`:

| SLO | Target (30d) | Error budget |
|---|---|---|
| Availability (non-5xx) | 99.5% | 216 min (~3h36m) / 30d |
| p95 latency | < 500 ms | — |
| Job success | 99% | 432 min (~7h12m) / 30d |
| Queue freshness | < 100 waiting | — |

Alerts in `ops/prometheus/alerts.yml` use **multi-window burn-rate** so a single
spike doesn't page, but a real outage pages within minutes.

---

## Enabling in production

1. **Metrics:** set `METRICS_TOKEN`; scrape **both** the API's `/metrics` and
   the worker's `:9464` (`WORKER_METRICS_PORT`) with
   `Authorization: Bearer <token>`. (Unset in prod → 404s, by design.)
2. **Traces:** `OTEL_ENABLED=true`, `OTEL_EXPORTER_OTLP_ENDPOINT=<collector/vendor>`,
   `OTEL_EXPORTER_OTLP_HEADERS=<ingest key>`, `OTEL_TRACES_SAMPLER_RATIO=0.1`.
   Span URL attributes are scrubbed of tokens/ids/query strings before export
   ([lib/spanRedaction.ts](../server/lib/spanRedaction.ts)) — but trace data
   still leaves the box, so use a vendor you have a BAA with (or self-host the
   collector).
3. **Errors:** `npm i @sentry/node`, set `SENTRY_DSN`, `SERVICE_ENV`, `RELEASE`.
   Keep `SENTRY_TRACES_SAMPLE_RATE=0` when `OTEL_ENABLED=true` — Sentry v8+ is
   itself OTel-based and two tracer providers in one process fight.
4. **Load alerts** `ops/prometheus/alerts.yml` into Prometheus/Grafana.
5. **Uptime monitor** on `/health/ready` with paging.

<a id="worker-metrics"></a>**Scraping the worker.** Job metrics live ONLY in
the worker process (prom-client registries are per-process). The worker serves
them itself on `WORKER_METRICS_PORT` ([workers/metricsServer.ts](../server/workers/metricsServer.ts)).
On Render, `type: worker` services accept **no inbound traffic**, so either run
the scraper inside the same private network (convert the worker to a private
service and point an in-network Prometheus/Grafana Alloy at it), host the
worker somewhere it can be reached (Fly/Railway/VM), or push instead of scrape
(Grafana Agent `remote_write` sidecar). Until one of those is wired, treat the
job-success SLO as unmeasured — `QueueBacklogGrowing` (fed by the API's lazy
queue sampling) is the backstop signal that jobs aren't draining.

All four telemetry paths are **off-by-default and additive**: with none set the
app still boots and emits structured, correlated logs. Nothing here is a hard
runtime dependency.

---

## Runbook anchors

<a id="api-down"></a>**API down / target down** — check the platform dashboard
for the deploy/instance; hit `/health` and `/health/ready`; if `/health/ready`
503s, read `checks` to see which dependency. Free-plan spindown? See the caveat
above.

<a id="dependency-down"></a>**Dependency down** — `dependency_up{dependency=...}`
identifies Postgres vs Redis. Redis down in prod also degrades rate limiting
(fails open) and stops job enqueue.

<a id="availability-slo"></a>**Availability SLO burn** — filter logs by
`event:"exception"`; group 5xx by `route`; open a trace for a failing request.

<a id="latency-slo"></a>**Latency SLO breach** — trace waterfall shows the slow
span (usually a DB query or downstream). Check `EventLoopLagHigh` for CPU
saturation.

<a id="job-failures"></a>**Job failures** — `jobs_total{outcome="failed"}` by
`queue`/`name` (scraped from the **worker** target, `:9464`); each failure is
captured with `route:"worker:<queue>"`.

<a id="queue-backlog"></a>**Queue backlog** — `queue_depth{state="waiting"}`
climbing = worker down or wedged. On Render, confirm the worker service is up
(**never** run it on `plan: free` — a spun-down worker never drains).

<a id="event-loop-lag"></a>**Event-loop lag** — instance is CPU-bound; scale up
or out.
