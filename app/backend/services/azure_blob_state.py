"""Azure Blob-backed JSON record storage for NetGravity.

The product does not need relational queries: its durable models are JSON
documents addressed by stable IDs.  This store maps each document to one blob
and uses Azure ETags for the few security counters that require atomic
read/modify/write behaviour across multiple web workers.

Blob names contain SHA-256 hashes rather than session tokens, e-mail addresses,
or other sensitive identifiers.  The original key remains inside the encrypted
blob payload so records can still be enumerated and restored.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")
Mutation = Callable[[Optional[Dict[str, Any]]], Tuple[Optional[Dict[str, Any]], T]]


# Only collections mirrored by process-local read registries participate in the
# change vector. Security counters, audit traces and OIDC/MFA records are read
# directly from Blob Storage and would otherwise force every worker to reload
# unrelated domain data on every request.
_CHANGE_TRACKED_COLLECTIONS = frozenset({
    "users",
    "sessions",
    "projects",
    "snapshots",
    "scenario_networks",
    "scenarios",
    "network_data",
    "analyses",
})
_SYSTEM_COLLECTION = "_system"
_CHANGE_VECTOR_KEY = "registry-change-vector"


class AzureBlobStateDatabase:
    """Small document database implemented entirely with Azure Blob Storage."""

    kind = "azure_blob"
    schema_version = 1
    migrations_applied: List[int] = []

    def __init__(self, container_client: Any, *, container: str,
                 prefix: str = "state/v1", create_container: bool = True) -> None:
        self._container = container_client
        self.container_name = container
        self.prefix = prefix.strip("/") or "state/v1"
        self.path = f"azure://{container}/{self.prefix}"
        self._write_lock = threading.RLock()

        from azure.core import MatchConditions
        from azure.core.exceptions import (
            ResourceExistsError,
            ResourceModifiedError,
            ResourceNotFoundError,
        )

        self._match_conditions = MatchConditions
        self._exists_error = ResourceExistsError
        self._modified_error = ResourceModifiedError
        self._not_found_error = ResourceNotFoundError

        if create_container:
            try:
                self._container.create_container()
            except ResourceExistsError:
                pass

    @classmethod
    def from_environment(cls) -> "AzureBlobStateDatabase":
        """Build a store from a connection string or Azure managed identity."""
        from azure.storage.blob import BlobServiceClient

        connection_string = (
            os.environ.get("NETGRAVITY_AZURE_CONN_STR")
            or os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
            or ""
        ).strip()
        account_url = (
            os.environ.get("NETGRAVITY_AZURE_STORAGE_ACCOUNT_URL") or ""
        ).strip()
        container = os.environ.get(
            "NETGRAVITY_AZURE_STATE_CONTAINER", "netgravity-state"
        ).strip()
        prefix = os.environ.get(
            "NETGRAVITY_AZURE_STATE_PREFIX", "state/v1"
        ).strip()

        if connection_string:
            service = BlobServiceClient.from_connection_string(connection_string)
        elif account_url:
            from azure.identity import DefaultAzureCredential

            service = BlobServiceClient(
                account_url=account_url,
                credential=DefaultAzureCredential(),
            )
        else:
            raise RuntimeError(
                "Azure Blob state storage is enabled, but neither "
                "NETGRAVITY_AZURE_CONN_STR nor "
                "NETGRAVITY_AZURE_STORAGE_ACCOUNT_URL is set."
            )

        create = os.environ.get(
            "NETGRAVITY_AZURE_CREATE_CONTAINERS", "true"
        ).strip().lower() not in {"0", "false", "no"}
        return cls(
            service.get_container_client(container),
            container=container,
            prefix=prefix,
            create_container=create,
        )

    @staticmethod
    def _serialise(key: str, record: Dict[str, Any]) -> bytes:
        return json.dumps(
            {"_key": key, "data": record},
            default=str,
            separators=(",", ":"),
        ).encode("utf-8")

    @staticmethod
    def _deserialise(raw: bytes) -> Tuple[str, Dict[str, Any]]:
        payload = json.loads(raw.decode("utf-8"))
        return str(payload["_key"]), dict(payload["data"])

    def _blob_name(self, collection: str, key: str) -> str:
        collection = collection.strip("/").replace("..", "_")
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return f"{self.prefix}/{collection}/{digest}.json"

    def _client(self, collection: str, key: str) -> Any:
        return self._container.get_blob_client(self._blob_name(collection, key))

    def _download(self, collection: str, key: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        try:
            stream = self._client(collection, key).download_blob()
            stored_key, record = self._deserialise(stream.readall())
            if stored_key != key:
                raise RuntimeError("Azure Blob state key digest collision detected")
            properties = getattr(stream, "properties", None)
            etag = getattr(properties, "etag", None)
            return record, etag
        except self._not_found_error:
            return None, None

    def get(self, collection: str, key: str,
            default: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        record, _ = self._download(collection, key)
        return default if record is None else record

    def put(self, collection: str, key: str, record: Dict[str, Any]) -> None:
        self._client(collection, key).upload_blob(
            self._serialise(key, record), overwrite=True
        )
        self._mark_changed(collection, record)

    def create(self, collection: str, key: str, record: Dict[str, Any]) -> bool:
        try:
            self._client(collection, key).upload_blob(
                self._serialise(key, record), overwrite=False
            )
            self._mark_changed(collection, record)
            return True
        except self._exists_error:
            return False

    def delete(self, collection: str, key: str) -> bool:
        previous = None
        if collection == "network_data":
            previous, _ = self._download(collection, key)
        try:
            self._client(collection, key).delete_blob()
            self._mark_changed(collection, previous)
            return True
        except self._not_found_error:
            return False

    def list(self, collection: str) -> List[Tuple[str, Dict[str, Any]]]:
        prefix = f"{self.prefix}/{collection.strip('/')}/"
        records: List[Tuple[str, Dict[str, Any]]] = []
        for item in self._container.list_blobs(name_starts_with=prefix):
            try:
                stream = self._container.get_blob_client(item.name).download_blob()
                records.append(self._deserialise(stream.readall()))
            except self._not_found_error:
                # A concurrent delete between listing and reading is harmless.
                continue
            except (TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
                logger.error("azure_blob_state.record_unreadable blob=%s error=%s",
                             item.name, exc)
        return records

    def count(self, collection: str) -> int:
        prefix = f"{self.prefix}/{collection.strip('/')}/"
        return sum(1 for _ in self._container.list_blobs(name_starts_with=prefix))

    def mutate(self, collection: str, key: str, mutation: Mutation[T], *,
               retries: int = 8, publish_change: bool = True) -> T:
        """Atomically mutate one record using optimistic ETag concurrency."""
        client = self._client(collection, key)
        with self._write_lock:
            for attempt in range(retries):
                current, etag = self._download(collection, key)
                replacement, result = mutation(
                    None if current is None else dict(current)
                )
                try:
                    if replacement is None:
                        if current is not None:
                            client.delete_blob(
                                etag=etag,
                                match_condition=self._match_conditions.IfNotModified,
                            )
                            if publish_change:
                                self._mark_changed(collection, current)
                        return result
                    payload = self._serialise(key, replacement)
                    if current is None:
                        client.upload_blob(payload, overwrite=False)
                    else:
                        client.upload_blob(
                            payload,
                            overwrite=True,
                            etag=etag,
                            match_condition=self._match_conditions.IfNotModified,
                        )
                    if publish_change:
                        self._mark_changed(collection, replacement)
                    return result
                except (self._exists_error, self._modified_error,
                        self._not_found_error):
                    if attempt == retries - 1:
                        raise RuntimeError(
                            f"Azure Blob state record stayed contended after {retries} attempts"
                        )
                    time.sleep(min(0.005 * (2 ** attempt), 0.2))
        raise RuntimeError("unreachable Azure Blob state mutation")

    def change_vector(self) -> Dict[str, str]:
        """Return the per-collection versions used for replica invalidation.

        The vector is one small blob regardless of the number of domain
        records. A worker compares it before a request and only rehydrates the
        registries whose token changed.
        """
        record = self.get(_SYSTEM_COLLECTION, _CHANGE_VECTOR_KEY) or {}
        versions = record.get("versions") or {}
        if not isinstance(versions, dict):
            return {}
        return {
            str(collection): str(version)
            for collection, version in versions.items()
            if (
                collection in _CHANGE_TRACKED_COLLECTIONS
                or collection.startswith("network_data:")
            ) and version
        }

    def _mark_changed(
        self, collection: str, record: Optional[Dict[str, Any]] = None
    ) -> None:
        """Atomically publish a new version for one cached collection."""
        if collection not in _CHANGE_TRACKED_COLLECTIONS:
            return

        # Upload records share one physical collection, but a published twin
        # state must not make every worker re-download all demand history and
        # dataset previews. The document's kind gives each logical registry its
        # own invalidation token while retaining one simple Blob layout.
        scope = collection
        if collection == "network_data" and record and record.get("kind"):
            scope = f"network_data:{record['kind']}"

        version = uuid.uuid4().hex

        def change(record: Optional[Dict[str, Any]]):
            versions = dict((record or {}).get("versions") or {})
            versions[scope] = version
            return {"versions": versions}, None

        # ``_system`` is intentionally not tracked, so this nested mutation
        # cannot recursively publish another change. ETag retries merge writes
        # made concurrently by different Container App replicas.
        self.mutate(_SYSTEM_COLLECTION, _CHANGE_VECTOR_KEY, change)

    def put_state(self, key: str, value: Any) -> None:
        self.put("app_state", key, {"value": value})

    def get_state(self, key: str, default: Any = None) -> Any:
        record = self.get("app_state", key)
        return default if record is None else record.get("value", default)

    def delete_state(self, key: str) -> bool:
        return self.delete("app_state", key)

    def take_state(self, key: str, default: Any = None) -> Any:
        """Read and delete one state value as a single ETag-guarded operation."""
        def take(record: Optional[Dict[str, Any]]) -> Tuple[None, Any]:
            value = default if record is None else record.get("value", default)
            return None, value
        return self.mutate("app_state", key, take)

    def list_state(self, prefix: str = "") -> List[Tuple[str, Any]]:
        return [(key, record.get("value"))
                for key, record in self.list("app_state")
                if key.startswith(prefix)]

    def close(self) -> None:
        credential = getattr(self._container, "credential", None)
        close = getattr(credential, "close", None)
        if callable(close):
            close()
