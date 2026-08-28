# Client-Facing Tier 1 UAT Report

Chrome exercised the actual local web application and API with the deterministic Tier 1 dataset on desktop and a 390x844 mobile viewport.

## Observed journey

- Owner login succeeded against the synthetic tenant.
- The first dashboard load exposed a branch-query HTTP 500 and a page-wide failure caused by one expected entitlement 403.
- After remediation, authorized branch data rendered, successful dashboard panels remained available, and the unavailable campaign panel was truthful.
- Navigation to unentitled modules consistently led to the subscription experience.
- Scheduling showed truthful zero-state data for the selected date (the seed clock is in July while the browser date was August).
- The booking dialog initially offered an unconstrained confirmed-appointment fallback. After remediation it requires patient, service, provider, and a canonical availability slot. With no provider configured, it disables booking and gives an actionable configuration message.
- The authenticated mobile scheduling layout remained readable with usable date and branch controls and no obvious overlap.

Client verdict: **REJECTED for release**. The corrected paths are materially more truthful, but a prospective client still encounters setup incompleteness, and system-level P1 risks remain in queue recovery and eligibility processing. No accessibility automation, full keyboard/screen-reader certification, or production-provider journey is claimed.
