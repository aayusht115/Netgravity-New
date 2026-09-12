# Source handoff checks

Source commit: `f6f8f8190acb33dfb555f0a2c31ab94d3c003ba1`.

- 1024 package files checked; no detected live credential patterns or sender-specific deployment identifiers.
- 1020 files exactly match the source commit. Only three README/integration documents and the new handoff guide differ.
- 308 retained validation/forecast reference files exactly match the originally supplied v3 ZIP.
- No Git history, live environment files, private-key files, user databases, uploaded data, credential caches, local scratch files or installed/build dependencies.
- Credential fields in both `.env.example` files are blank. Compose has one explicitly documented local Azurite emulator key; test-only dummy credentials remain in tests.
- Office document containers were scanned as well as source text. This is a best-effort disclosure check, not a full security audit.

The archive is checked for CRC integrity, safe paths and per-file SHA-256 hashes after creation. `SHARE_MANIFEST.sha256` covers every packaged file except the manifest itself. Runtime code and configuration were not rewritten for packaging.
