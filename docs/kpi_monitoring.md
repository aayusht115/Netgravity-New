# Facility KPI monitoring

The Python service evaluates user-created facility rules against the authoritative
baseline for a project's newly uploaded network version. It is not a telemetry
connector: data must be ingested and bound to the project before it can be
evaluated. No extra database, queue, scheduler service, or LLM call is required.
State is JSON in the existing Azure Blob store (local tests use SQLite app state).

## Controls

- `GET /api/kpi-monitors?project_id=...` returns the caller's monitors and
  capabilities, including actual email configuration and worker status.
- `POST /api/kpi-monitors` creates one monitor for an owned, non-demo project's
  facility. Required fields: `project_id`, `facility_id`, `rules`. Optional:
  `instructions`, `enabled` (defaults to `false`). A duplicate facility monitor
  returns `409`; retrying a request cannot silently create two email rules.
- `PATCH /api/kpi-monitors/<id>` takes `project_id` and at least one of `enabled`,
  `rules`, or `instructions`. Editing rules or enabling a paused monitor establishes
  a new baseline and refreshes the recipient to the authenticated account's current
  email. It does not replay changes while paused. Instructions-only edits preserve
  the comparison baseline. The recipient cannot be supplied to PATCH.

Each rule has `metric`, `direction`, and a finite, non-negative `threshold`.
Supported metrics are `utilization_pct`, `peak_utilization_pct`,
`throughput_units`, `throughput_units_per_period`, and `capacity_units`.
Directions are `increase`, `decrease`, `above`, and `below`. Change thresholds
must be positive; they are absolute units, **percentage points** for utilisation.
Above/below trigger only when the value crosses the threshold, not on every new
version while it remains outside it. Multiple rules are OR'ed into one email.

Instructions are supplemental human context. They are never executed, sent to an
LLM, or used to alter a threshold or recipient. The only recipient permitted is
the authenticated account email. Creating/enabling a rule is the user's opt-in;
deployment never creates rules or sends test email.

## Background execution

Production starts a daemon polling worker after durable stores and cross-replica
synchronization are installed. It refreshes shared state, evaluates active rules,
and computes/caches a new authoritative baseline when necessary, without a
browser request. The default interval is 60 seconds (plus any solve duration).

- `NETGRAVITY_KPI_MONITOR_WORKER=true` enables it in local development.
- `NETGRAVITY_KPI_MONITOR_WORKER=false` disables it in any environment.
- `NETGRAVITY_KPI_MONITOR_INTERVAL_SECONDS` selects 30–3,600 seconds.

Keep at least one Python replica running. A scaled-to-zero or stopped deployment
cannot poll. The worker requires durable storage; it is not installed if startup
durability initialization failed. Each replica may poll, but the per-monitor
Blob ETag claim permits only one email attempt for a data version.

## Evidence and delivery safeguards

The first comparable version establishes a baseline with no alert. Values must
be valid, finite, facility-scoped and non-hypothetical, with the expected unit.
Missing values are not zero. Comparison requires the same facility identity and
the exact labelled planning horizon; rolling to a different month establishes
new context, not a like-for-like change. Unlabelled horizons cannot trigger.

Deleting/reassigning a project, removing/replacing a facility, or changing the
account email pauses its monitor. Unbinding a project clears its comparison.
Explicitly resuming re-baselines; restoring an already processed upload never
replays its alert. A snapshot binding is rechecked after solving and before send.

SMTP uses the existing Action Agent email sender. No SMTP configuration means
`stubbed`, with no send attempted. An API key alone is not an implemented mail
transport. SMTP acceptance is recorded as `sent`, not proof of inbox delivery.
Refused recipients are `failed`. A send exception or crash after a durable claim
is `delivery_uncertain`: it may have been accepted, so it is **not automatically
retried**. This is at-most-one attempt, not exactly-once delivery. Operators can
inspect the last alert's state; changing SMTP configuration does not replay old
stubbed or uncertain notifications. Credentials and raw provider error details
are not returned by the monitoring API.

Automated verification: `pytest -q netgravity/tests/test_kpi_monitors.py`.
