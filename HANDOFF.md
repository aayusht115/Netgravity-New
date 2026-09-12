# NetGravity — team source handoff

Prepared 11 September 2026 from commit `f6f8f8190acb33dfb555f0a2c31ab94d3c003ba1`.
The ZIP preserves the original single `NetGravity-main/` root and source layout.
It is a source distribution, not a copy of a live environment or a deployment.

## Changes included

- The supplied v3 frontend and Python Flask backend remain the active workflows.
- The retained Atlas Digital Twin provides 2D/3D geographic maps, facility-role
  icons, DC utilisation rings, demand heat, IDs and expandable facility tables.
- The shared Atlas theme and latest visual polish include the subtle network
  backdrop, metric/lens icon accents, card borders, table styling and short
  reduced-motion-aware transitions. No image service is called at runtime.
- Next.js hosts the interface and proxies the Python APIs on the same origin.
  The canonical UI is in `app/frontend`; Next copies its assets automatically
  before development or builds. It is not a full rewrite into React components.
- Azure Blob support and the generic container/deployment templates are retained.
  The backend is Flask, not FastAPI. No PostgreSQL service is required.
- Retired custom modules remain clearly separated in `legacy/pre-v3` for
  reference only; they are not active or included in deployment images.

## Run locally

### Option A: Docker, Next.js + Python + local Blob emulator

From this folder, with Docker Compose available:

```bash
docker compose up --build
```

Open `http://localhost:3000`. The Python API uses port 8000; Azurite uses 10000.
Create a new account/project and upload your own workbook. No account or project
from the sender's local or Azure environment is included.

`compose.yaml` intentionally contains a LOCAL-ONLY Azurite emulator credential.
It is paired with the emulator running in that Compose stack and is not a real
Azure storage key. It cannot authenticate to the sender's Azure account.
Never reuse an emulator or test-fixture credential in production.

### Option B: Python and Next.js without Docker

Use Python 3.11+ and Node.js 20.9+ (Node 22 is a suitable local choice).
From the extracted project root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python run.py
```

In a second terminal, from the same root:

```bash
cd frontend-next
npm ci
PYTHON_API_URL=http://127.0.0.1:5050 npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000`. With no external configuration, this option uses
local development storage. For the Blob-backed local path use Option A.
Shell activation/environment syntax differs on Windows.

## Configuration and credentials

The root `.env.example` and `frontend-next/.env.example` retain their variable
names and current non-secret defaults. Credential fields are blank. Supply
your own provider settings and credentials privately; do not put them into
frontend code, Git, or a ZIP intended for sharing.

- Dashboard/orchestrator narration uses the team's text gateway configuration:
  `TEXT_API_URL`, `TEXT_API_TOKEN`, `TEXT_API_MODEL`. An OpenAI API key is not a
  text-gateway token. There is no live AI credential configured in this ZIP.
- Document-ingestion provider settings are separate `NETGRAVITY_*` variables
  documented in `.env.example`. Keep the two configurations distinct.
- Configure your own Azure account/managed identity or storage connection
  string for deployment. Generic templates remain; the sender's environment
  addresses, resource identifiers and rollout records do not.
- Email/OIDC settings likewise require your own approved provider configuration.
- Dummy credentials inside unit tests and the explicitly synthetic local QA
  runner are test fixtures, not live user accounts or production secrets.

## What was left out

Git history/remotes, live `.env` files, API keys, real connection strings,
credential caches, local databases, sessions, user uploads, backups, scratch
work, installed dependencies, build caches and our generated local/deployment
reports are not included. The few operational-only documents that referred to
our deployment/screenshots were excluded or replaced with generic instructions.

Retained upstream validation/forecast reference artefacts are byte-identical
to files in the original supplied v3 ZIP. They are not exports of the sender's
new local projects. Historical documentation and the standalone prototype remain
for reference; use the current entry points above and `docs/v3_integration.md`.

Only README/handoff documentation is adjusted in this share copy. Application
source, solver code, dependency versions, `.env.example` files, Compose and
Bicep configuration are unchanged from the stated commit.

## Verification and limits

The current Next.js production build passed locally. Atlas JavaScript checks
and 110 targeted integration tests also passed against this extracted handoff
copy, without live provider credentials. The broader v3 suite has documented remaining
failures; see `docs/v3_integration.md`. This handoff is not a claim of production
readiness, successful live AI/email setup, or a full security audit.

Git-dependent working-tree checks may explicitly skip in this source-only ZIP,
because no `.git` directory is distributed.

The ZIP is checked for integrity, unsafe paths, excluded runtime files,
credential patterns and sender-specific deployment identifiers. A hash manifest
is included as `SHARE_MANIFEST.sha256`. Scanning reduces accidental disclosure
risk but cannot certify the absence of every possible secret format.

Any key previously disclosed in a message should be rotated separately; source
packaging does not revoke it or change its access to the provider.
