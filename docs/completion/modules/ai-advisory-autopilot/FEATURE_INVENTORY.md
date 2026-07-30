# M15 AI Advisory, Recommendations, Guardrails and Autopilot — Feature Inventory

Pod: AI Governance Pod. Embedded consultant: healthcare AI governance/prompt-safety consultant. Independent reviewer: AI model-risk consultant. Data: INTERNAL by default; PHI-H only if explicitly enabled and approved. Dependencies: M01-M07, M16, M19-M23.

| ID | Feature/value | Roles/journeys | UI/API trace | Data/jobs/integrations | Controls/audit/isolation/flags/demo | Evidence/missing/acceptance | Status |
|---|---|---|---|---|---|---|---|
| M15-F01 | Advisory briefing | Staff; load/empty/degraded provider | `/advisory`; `/brief` | operational aggregates | tenant scope, evidence refs, no fabricated values | Advisory governance tests pass selected behavior; browser/data lineage incomplete | IN DISCOVERY |
| M15-F02 | Advisory question/answer | Staff; safe question, PHI, injection, timeout | `/advisory`; `/ask` | AI providers | PHI off by default, clinic guardrail, no diagnosis, source evidence, truthful fallback | Governance tests exist; prompt-injection/red-team/provider evidence incomplete | IN DISCOVERY |
| M15-F03 | AI provider gateway/health | Admin; configured/unconfigured/timeout/budget | `/ai/providers/health-check` | Ollama/OpenAI/Claude | secrets server-only, timeout, provider truth, deployment mock gate | AI/provider failure tests pass locally; approved live provider external | EXTERNAL BLOCKED |
| M15-F04 | Recommendation generation/list | Managers; generate/list, insufficient evidence, retry | AI recommendation APIs | `AIRecommendation`, consumes signals | manage role, evidence/provenance/confidence, no autonomous clinical action, audit | AI integration tests pass selected paths; cross-module acceptance incomplete | IN DISCOVERY |
| M15-F05 | AI usage/cost/evaluation | Admin/analyst; summary/evaluations/budget exceeded | AI usage/evaluation APIs | `AIUsageLog`, `AIEvaluation` | tenant scope, no prompt PHI logs, daily budget/kill switch, audit | AI tests exist; production pricing/model evaluation program external | IN DISCOVERY |
| M15-F06 | Guardrail CRUD/enforcement | Owners/managers; configure/test/delete/invalid | Settings guardrails UI/APIs | `AiGuardrail` | settings permission, tenant scope, deny precedence, audit | CRUD routes exist; end-to-end enforcement and browser evidence incomplete | IN DISCOVERY |
| M15-F07 | Autopilot playbooks/approvals | Managers; list, approve/dismiss, denied role/stale | `/autopilot`; approval APIs | `AutopilotPlaybook`, `AutopilotApproval` | explicit human approval, transition guard, audit | Autopilot/advisory tests selected; browser/race/evidence incomplete | IN DISCOVERY |
| M15-F08 | Approved action worker | Worker; execute once/retry/fail/unknown job | `autopilot-execution` | approval + domain action | signed/tenant-bound job, deterministic ID, attempts/backoff, audit, no self-approval | Worker integration tests cover runtime; action-by-action consumer contracts incomplete | IN DISCOVERY |

