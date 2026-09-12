# Team v3 + Atlas Digital Twin

Local integration and design polish performed on September 11, 2026. The user
has authorised committing and pushing this integrated source version.
**No Azure deployment was performed for this integration.** A source push is
not a production-readiness sign-off; the remaining validation issues are below.

## What is authoritative

The supplied `NetGravity-main v3.zip` now owns the application: its Executive
view, ingestion, KPI dashboards, insights, forecasting, scenario builder,
calculation documents, Python APIs and solver changes are imported. The backend
is the team's **Flask** application; it has not been rewritten as FastAPI.

Our existing **Digital Twin** is the one component-layout exception. It retains geographic
relief in 2D/3D, shared facility-role icons and DC utilisation colours, uploaded
demand heat, camera controls, expandable facility strips, IDs and drill-downs.
The team's hover-card interaction fix also applies to the preserved 3D view.
Its scenario thumbnail remains the team's renderer, not the Atlas renderer.

At the user's subsequent request, the **pre-v3 Atlas styling is restored**
across the workspace. `app/frontend/css/atlas-theme.css` supplies the shared
palette, typography weights, spacing, navigation, cards and tables. It adapts
to the team's current components rather than bringing back retired UI modules.
Inter remains locally hosted; no new font or external styling dependency is
introduced. The screen-only layer leaves print styling alone. The separately
scoped `atlas-workspace.css` still owns Digital Twin geometry and map controls.

The subsequent design-polish pass adds a locally bundled, approximately 25 KB
network-inspired background, keyed KPI icon accents, existing-library icons on
the lens tabs, restrained card borders, clearer table headers/row striping and
short UI transitions. Risk labels/colours still come from the existing data
logic. The backdrop is decoration, not geographic or facility data, and does
not replace the Digital Twin map. No additional font/animation dependency or
image API is needed at runtime. Reduced-motion and print rules are retained.

Next.js remains the frontend host and same-origin API proxy. `app/frontend`
is the canonical UI source, automatically copied into Next's public directory
before builds. This preserves the team's screens; it is not a rewrite of every
screen into React components.

Azure Blob uploads/state, authentication protections, durable registry loading,
replica invalidation and deployment packaging are retained. No PostgreSQL
service is added or required. The new uploaded-forecast store is included in
durability and invalidation. Existing deployment settings were not applied to
Azure during this work.

Superseded custom KPI, forecast, scenario-location, calculation and AI modules
and their old tests are recoverably archived under `legacy/pre-v3/`. They are
not imported or deployed. Historical validation artifacts are untouched.

## Run and inspect locally

The review servers are on **http://127.0.0.1:3017** (Next.js) and port **5057**
(Python). The local fixture login is:

- Email: `kpi-review@example.test`
- Password: `LocalKpiReview!2026`

Open **Location QA — synthetic network**. It is deliberately labelled test
data, not a production account. Upload smoke tests may also appear as projects.
This isolated runner uses an in-memory development store and temporary upload
directory, disables live AI/email, and loses its test state when restarted.
It never connects to production Blob. It does not change the hosting design.

To restart from the repository root, with Python dependencies installed:

```bash
.venv/bin/python scripts/run-kpi-review.py --with-location-data --with-demand-history --port 5057
```

In a second terminal, with Node.js on PATH:

```bash
cd frontend-next
npm ci
PYTHON_API_URL=http://127.0.0.1:5057 npm run dev -- --hostname 127.0.0.1 --port 3017
```

For the existing Blob/Azurite development and Azure packaging workflow, see
[`azure/README.md`](../azure/README.md). Do not run deployment commands until a
release is explicitly authorised and verified.

## Integration boundaries and verification

`GET /api/network/demand-surface` is a read-only, authenticated projection of
the owned project's bound snapshot. It sums actual demand rows by market ID,
reports unmapped demand, and rejects a stale snapshot. The map shows the full
uploaded planning horizon, not a forecast or a selected-period view. The UI
discloses this scope and clears old heat on project/snapshot changes or errors.
Neither this endpoint nor either renderer modifies scenario or solver inputs.

Verified locally:

- Next production build and TypeScript checks pass.
- Atlas executable JavaScript checks pass: projection, utilisation boundaries,
  inactive sites, IDs/columns, demand scope and stale/error/empty responses.
  The Leaflet heat canvas owns its absolute positioning, so removing the old
  scenario stylesheet cannot offset density away from market coordinates.
- Focused Python merge/Blob/Twin/security checks: **89 passed**.
- HTTP end-to-end checks pass through the Next proxy: cookie authentication and
  CSRF, project isolation, workbook preview/commit, KPIs, insights, mapped demand,
  model forecast, a solved 5% demand scenario, and forecast/scenario DOCX bodies.
- Browser: sign-in/project selection, Executive view, KPI page, forecast and
  methodology, scenario comparison/detail, both Twin modes and market details.
- Full Python suite: **4,389 passed, 8 failed, 4 skipped**. The suite is not green.

Run the repeatable HTTP check while the review servers are running:

```bash
.venv/bin/python scripts/verify-v3-integration.py
node --experimental-vm-modules scripts/test-atlas-workspace.mjs
.venv/bin/python -m pytest netgravity/tests -q
```

The eight remaining failures are explicitly retained, not hidden by skips:

1. Seven reproduce in the unmodified v3 zip: two prompt numeric-format
   expectations, two scenario recommendation wording expectations, two chart
   label source-shape expectations, and one narrative rounding/precision
   expectation. They need reconciliation with the team's expected behaviour.
2. At the time of that full-suite run, the solver working-tree guard rejected
   the intentional, uncommitted v3 import of `netgravity/optimization/milp.py`.
   That file is byte-identical to the zip. The later user-authorised commit
   records the import; it does not resolve the seven team-v3 behaviour failures.

Tests specifically asserting the replaced v3 Twin layout were updated to the
Atlas contract. The unmodified zip's full suite had 42 failures, including
missing packaged data fixtures; that run is not directly comparable by count.
Local run logs are not included in the source handoff. The summary above is
retained so the known failures are not hidden. See `HANDOFF.md` for archive scope.

## Not a production-readiness sign-off

No live AI, email, Azure credentials, production uploads, container rollout,
load test or multi-replica v3 verification was performed. The team v3 dashboard
uses its text gateway contract (`TEXT_API_URL`, `TEXT_API_TOKEN`,
`TEXT_API_MODEL`), separately from ingestion's provider settings. An OpenAI API
key is not a text-gateway token. Real AI configuration must be confirmed and
stored in backend secrets before live testing; no supplied key was reused.

Source archive SHA-256:
`5d064a7a41d4db48ce1ea3697bfaad28e2eb2b1544228614c5b96d9ad746e872`.
Archive comment revision: `d806da82272a0049b2b8478d05c92050b6e5db1a`.
The original supplied zip remains unchanged. Machine-specific backup paths and
local working files are not included in the source handoff.
