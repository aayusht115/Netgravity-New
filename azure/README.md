# Azure deployment

> This source handoff does not include or grant access to an existing Azure
> deployment. Supply your own subscription, resource group, registry and
> storage configuration. See [HANDOFF.md](../HANDOFF.md) and
> [v3 integration and verification](../docs/v3_integration.md) before planning
> a release. Live AI and multi-replica v3 behaviour have not been verified by
> the local integration checks.

## Deployment architecture

The commands and Bicep template below are generic. Existing environment URLs,
resource identifiers and historical deployment records are omitted from this
share copy. No live Azure credentials or deployment parameter files are bundled.

The public frontend is the user-facing URL. Its same-origin `/api/*` and
`/orchestrator/*` routes proxy to the Python app. Next.js packages and serves
the approved UI from `app/frontend`; the sync runs automatically before local
development and production builds so those original screens remain the visual
source of truth.

The Overview shows scope filters first, headline KPIs next, then three priority
attention tiles with individual evidence and mitigation deep dives. Additional
findings remain available in a collapsed list. The Digital Twin remains under
Baseline and is no longer duplicated on Overview.

NetGravity now deploys as three Azure-native pieces:

- Next.js frontend container (`frontend-next/Dockerfile`)
- Python/Flask backend container (`Dockerfile.backend`)
- Azure Blob Storage for uploads and durable application JSON

There is no PostgreSQL resource or connection string in this deployment. The
frontend proxies `/api/*` and `/orchestrator/*` to Python, keeping authentication
cookies on one browser origin.

## Local ports first

From the repository root:

```bash
docker compose up --build
```

Open `http://localhost:3000`. Python is available directly at
`http://localhost:8000/api/status`. Azurite runs on port `10000` and exercises
the same Blob APIs used in Azure.

## Deploy to Azure Container Apps

1. Build and push both images to a registry accessible by Container Apps.
2. Deploy the included Bicep file with those two image names:

```bash
az deployment group create \
  --resource-group <resource-group> \
  --template-file azure/main.bicep \
  --parameters backendImage=<registry>/netgravity-api:<tag> \
               frontendImage=<registry>/netgravity-web:<tag> \
               containerRegistryName=<registry-name>
```

The template provisions the Container Apps environment, both apps, Blob
containers, and soft deletion/versioning. Registry and Storage credentials are
resolved during deployment and stored as Container Apps secrets; they are not
passed as parameters or committed to source control. In subscriptions where
the deployer can create role assignments, these secrets can later be replaced
with managed-identity access.

The Python app uses one gunicorn process with four request threads **per
replica** and scales from one to four replicas. Writes to cached domain
collections atomically advance a compact change vector in Blob Storage. Before
each request, a replica compares that vector and reloads only the affected auth,
project, upload, snapshot, scenario, analysis or published Digital Twin
registry. A refresh failure is returned as a visible `503` instead of serving
known-stale ownership or network state.

Container Apps session affinity is enabled in single-revision HTTP mode. It
keeps short-lived, in-flight solve/approval state on the replica that created
it; completed traces, domain records and result documents remain shared in
Blob. The explicit HTTP scale rule adds replicas above four concurrent requests
and caps the backend at four replicas. The frontend scales independently.

Use the emitted `frontendUrl` as `NETGRAVITY_PUBLIC_URL` on the Python app when
password-reset or OIDC callbacks are enabled.
