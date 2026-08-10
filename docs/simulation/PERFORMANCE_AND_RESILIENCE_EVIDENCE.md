# Performance and Resilience Evidence

Environment: local macOS, Node 24, PostgreSQL 17 and Redis 7 containers. This is functional regression evidence, not a production capacity claim.

| Probe | Dataset/load | Observation | Verdict |
|---|---|---|---|
| Tier 1 generation | 4 tenants, 8 clinics, 1,000 patients plus dependent records | 86 migrations and deterministic seed completed | PASS |
| Core clinic regression | 5 files / 36 tests | 77.67 s | PASS |
| Finance regression | 3 files / 42 tests | 70.09 s | PASS |
| Autopilot recovery | 101 candidate approvals | 17.487 s with a 30 s test timeout; default 5 s timed out | REJECTED for operational throughput |
| Worker exact-once paths | Real PostgreSQL and Redis, 4 scenarios | Real staff-task effect, stale fence, unsupported denial, retry receipt all pass | PASS |
| Redis persistence/restart boundary | Chrome worker against persistent local Redis and disposable DB | Old jobs targeted tenants absent from the current DB and generated repeated fail-closed errors | REJECTED; queue namespace isolation required |
| Redis outage voice control | Simulated fault | Rate-store failure fails closed/hands off | PASS |
| Full disposable regression | 109 files / 1,902 tests | 106 files and 1,899 tests passed; three tests exceeded 5 s; total 1,039.75 s | FAIL timing gate |
| Failed-file focused rerun | 3 files / 60 tests | All passed with 30 s test ceiling in 125.50 s | Functional PASS; performance risk remains |

No defensible p50/p95/p99, database utilization, connection-pool pressure, or sustained throughput claim was produced in this Tier 1 wave. Those measurements are blocked from scale escalation until queue isolation and recovery throughput are corrected.
