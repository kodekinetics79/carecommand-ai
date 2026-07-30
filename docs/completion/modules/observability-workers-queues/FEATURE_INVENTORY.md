# M21 Monitoring, Logging, Health, Workers and Queues — Feature Inventory

Pod: Reliability Pod. Embedded consultant: SRE/incident-response/observability consultant. Independent reviewer: production-reliability consultant. Data: INTERNAL/SENSITIVE; telemetry must exclude PHI. Dependencies: M01-M03, M19, M23-M24; worker domains M11/M14/M15/M19.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M21-F01 | Liveness/readiness | Orchestrator/SRE; live, DB/Redis degraded | `/health/live`, `/health/ready`, `/health` | PostgreSQL/Redis probes | no secret/PHI, distinct live vs ready, bounded timeout | Observability tests pass; deployed orchestration evidence external | EXTERNAL BLOCKED |
| M21-F02 | Integration posture health | SRE/customer evaluator; configured/mock/unavailable | `/health/integrations` | all provider configs | provider IDs/modes only, deployment profile gate, no credential value | Env/observability pillar tests pass | COMPLETE |
| M21-F03 | SLO health | SRE; normal/breached/insufficient data | `/health/slo` | in-process metrics | truthful window/threshold, no PHI dimensions | Observability tests pass locally; alert consumption external | IN DISCOVERY |
| M21-F04 | Prometheus metrics | Authenticated scraper; authorized/denied/no token | `/metrics`, worker metrics port | Prometheus | bearer protected or 404 production, bounded labels, no PHI | Metrics tests exist; deployed scraper/dashboard external | EXTERNAL BLOCKED |
| M21-F05 | Structured logging/redaction/error capture | SRE; 4xx/5xx/provider/worker failure | logger/error/observability seams | Sentry optional | request/trace IDs, redacted payload, no patient/token/secret | Observability hardening tests pass; Sentry dependency explicitly not installed/configured | EXTERNAL BLOCKED |
| M21-F06 | Distributed tracing | SRE; request→job→worker, disabled/export failure | OTEL API/worker boot | OTLP | PHI-safe spans, trace carrier signed with jobs, sampling | Tracing/observability tests pass locally; collector evidence external | EXTERNAL BLOCKED |
| M21-F07 | Queue runtime/retry/backoff/shutdown | Worker/SRE; start/retry/fail/disabled/graceful stop | worker runtime | Redis/BullMQ four queues | deterministic jobs, bounded attempts/backoff, close cleanly, truthful disabled | Worker tests exist; production Redis/soak/DLQ alert evidence external | EXTERNAL BLOCKED |
| M21-F08 | Signed tenant job envelopes | Domain workers; scheduler tick, tenant fanout, tamper/replay | queue helpers/workers | no model | HMAC domain separation, active tenant resolver, no untrusted tenant ID | Envelope/resolver/worker tests pass | COMPLETE |
| M21-F09 | Queue depth/failure alerting | SRE; backlog/failure/recovery | sampling metrics | Redis/Prometheus/alert manager | no payload/PHI, per-queue bounded labels, actionable thresholds | Sampling code/tests exist; actual alert delivery/on-call acknowledgement external | EXTERNAL BLOCKED |

