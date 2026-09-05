# Today / Operational Briefing

Scope: replace the current general Command Center landing composition with a role-led Today workspace for an authenticated multi-clinic practice manager. The first implementation may reuse existing truthful read models and deep-link to existing modules; it must not fabricate unified records that the backend does not yet provide.

Audience and job: a practice manager beginning or running a busy shift needs to know what changed, what is at risk, who owns each item, which clinic it affects, how old the evidence is, and the safest next action.

Primary action: open the highest-priority source workflow with clinic scope and context preserved. Secondary actions: assign work, inspect evidence, open the full queue, and enter the PHI-safe executive proof view.

Required content: persistent network/clinic/timezone scope; concise operational brief; three priority actions; live work ledger; owner, SLA, source, freshness, status and next action; connection-health strip; clearly labelled synthetic state where applicable.

Constraints: preserve the existing navy/indigo clinical identity and familiar controls; maintain RBAC and entitlement behavior; no PHI in buyer proof; no unsupported metrics or connectivity claims; critical states must not rely on color alone; responsive and keyboard-accessible.

Chosen composition: Operational Briefing. Approved comp: `.impeccable/mocks/decision/operational-briefing.webp`.

Memorable moment: the morning brief and its three numbered actions resolve directly into the same accountable work ledger below—summary and evidence are visibly one system.

Unresolved decisions: the durable backend shape for a cross-module work item, global scope persistence across routes, and the final buyer-proof dataset remain separate implementation work and must be represented honestly until wired.
