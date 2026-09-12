"""
NetGravity — Azure Blob Storage Backend
========================================
The zone/key layout is identical to LocalStorage, so keys written locally
resolve unchanged against Blob containers:

    zone "raw"          -> container "raw"          (immutable, versioning on)
    zone "standardized" -> container "standardized"
    zone "curated"      -> container "curated"

To activate on Azure with managed identity (recommended):
    NETGRAVITY_STORAGE_BACKEND=azure_blob
    NETGRAVITY_AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net

A connection string in NETGRAVITY_AZURE_CONN_STR remains supported for local
Azurite development and deployments that cannot use managed identity.
"""

from __future__ import annotations

from typing import List, Optional, Set

from netgravity.ingestion.storage.base import StorageBackend


class AzureBlobStorage(StorageBackend):
    def __init__(self, connection_string: str = "", account_url: str = ""):
        if not connection_string and not account_url:
            raise ValueError(
                "Azure Blob backend selected but neither NETGRAVITY_AZURE_CONN_STR "
                "nor NETGRAVITY_AZURE_STORAGE_ACCOUNT_URL is set."
            )
        self.connection_string = connection_string
        self.account_url = account_url
        self._service = None
        self._ready_zones: Set[str] = set()

    def _client(self):
        if self._service is None:
            try:
                from azure.storage.blob import BlobServiceClient  # lazy import
            except ImportError as exc:  # pragma: no cover - deployment-only path
                raise ImportError(
                    "azure-storage-blob is not installed. "
                    "Run `pip install azure-storage-blob` to use the azure_blob backend."
                ) from exc
            if self.connection_string:
                self._service = BlobServiceClient.from_connection_string(
                    self.connection_string
                )
            else:
                from azure.identity import DefaultAzureCredential
                self._service = BlobServiceClient(
                    account_url=self.account_url,
                    credential=DefaultAzureCredential(),
                )
        return self._service

    def _container(self, zone: str):
        container = self._client().get_container_client(zone)
        if zone not in self._ready_zones:
            from azure.core.exceptions import ResourceExistsError
            try:
                container.create_container()
            except ResourceExistsError:
                pass
            self._ready_zones.add(zone)
        return container

    def _blob(self, zone: str, key: str):
        return self._container(zone).get_blob_client(key)

    def save(self, zone: str, key: str, data: bytes) -> str:  # pragma: no cover
        self._blob(zone, key).upload_blob(data, overwrite=True)
        return self.locator(zone, key)

    def get(self, zone: str, key: str) -> bytes:  # pragma: no cover
        return self._blob(zone, key).download_blob().readall()

    def exists(self, zone: str, key: str) -> bool:  # pragma: no cover
        return self._blob(zone, key).exists()

    def list(self, zone: str, prefix: str = "") -> List[str]:  # pragma: no cover
        container = self._container(zone)
        return [b.name for b in container.list_blobs(name_starts_with=prefix)]

    def locator(self, zone: str, key: str) -> str:  # pragma: no cover
        return f"azure://{zone}/{key}"
