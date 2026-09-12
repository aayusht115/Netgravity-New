"""The Azure-only durable store, exercised without network credentials."""

from types import SimpleNamespace

from azure.core.exceptions import (
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)

from app.backend.services.azure_blob_state import AzureBlobStateDatabase
from app.backend.services.blob_persistence import BlobPersistence
from app.backend.services.replica_sync import ReplicaSynchronizer


class _Download:
    def __init__(self, data: bytes, etag: str) -> None:
        self._data = data
        self.properties = SimpleNamespace(etag=etag)

    def readall(self) -> bytes:
        return self._data


class _Blob:
    def __init__(self, container: "_Container", name: str) -> None:
        self.container = container
        self.name = name

    def upload_blob(self, data: bytes, *, overwrite: bool, etag=None,
                    match_condition=None) -> None:
        current = self.container.blobs.get(self.name)
        if current and not overwrite:
            raise ResourceExistsError("exists")
        if current and etag is not None and current[1] != etag:
            raise ResourceModifiedError("changed")
        if not current and etag is not None:
            raise ResourceNotFoundError("gone")
        version = str(int(current[1]) + 1) if current else "1"
        self.container.blobs[self.name] = (bytes(data), version)

    def download_blob(self) -> _Download:
        try:
            data, etag = self.container.blobs[self.name]
        except KeyError as exc:
            raise ResourceNotFoundError("missing") from exc
        return _Download(data, etag)

    def delete_blob(self, *, etag=None, match_condition=None) -> None:
        current = self.container.blobs.get(self.name)
        if not current:
            raise ResourceNotFoundError("missing")
        if etag is not None and current[1] != etag:
            raise ResourceModifiedError("changed")
        del self.container.blobs[self.name]


class _Container:
    def __init__(self) -> None:
        self.created = False
        self.blobs = {}

    def create_container(self) -> None:
        if self.created:
            raise ResourceExistsError("exists")
        self.created = True

    def get_blob_client(self, name: str) -> _Blob:
        return _Blob(self, name)

    def list_blobs(self, *, name_starts_with: str):
        return [SimpleNamespace(name=name) for name in sorted(self.blobs)
                if name.startswith(name_starts_with)]


def _store():
    container = _Container()
    return AzureBlobStateDatabase(
        container, container="netgravity-state", prefix="state/v1"
    ), container


def test_records_are_json_blobs_and_blob_names_do_not_leak_keys():
    store, container = _store()
    secret_key = "ngt_this-session-token-must-not-be-a-blob-name"

    store.put("sessions", secret_key, {"user_id": "user-1"})

    assert store.get("sessions", secret_key) == {"user_id": "user-1"}
    assert store.list("sessions") == [(secret_key, {"user_id": "user-1"})]
    assert all(secret_key not in name for name in container.blobs)
    assert store.count("sessions") == 1
    assert store.delete("sessions", secret_key) is True
    assert store.get("sessions", secret_key) is None


def test_mutation_and_single_use_security_records():
    store, _ = _store()
    records = BlobPersistence(store)

    first = records.record_login_failure("person@example.com", 100, 60, 2, 300)
    second = records.record_login_failure("person@example.com", 101, 60, 2, 300)
    assert first == {"failures": 1, "locked_until": None}
    assert second == {"failures": 2, "locked_until": 401}

    records.save_password_reset("hash", "user-1", 100, 200)
    assert records.consume_password_reset("hash", 120) == 1
    assert records.consume_password_reset("hash", 121) == 0

    records.save_mfa_enrolment("user-1", "secret", 100, 101)
    assert records.claim_mfa_step("user-1", 7) is True
    assert records.claim_mfa_step("user-1", 7) is False


def test_projects_sessions_and_network_documents_round_trip():
    store, _ = _store()
    records = BlobPersistence(store)
    project = {"id": "project-1", "name": "Network"}

    records.save_user("user-1", "Owner@Example.com", {"user_id": "user-1"}, 1)
    records.save_project("project-1", "user-1", project, 2)
    records.save_session_record("token", "user-1", 50, 1, 2, 100, "browser")
    records.save_network_data("dataset", "network-1", {"rows": 12})

    assert records.load_users() == [{"user_id": "user-1"}]
    assert records.load_projects() == [project]
    assert records.load_session_records(20)[0]["client"] == "browser"
    assert records.load_network_data("dataset") == {"network-1": {"rows": 12}}


def test_application_state_supports_oidc_prefix_listing():
    store, _ = _store()
    store.put_state("oidc_pending:a", {"expires_at": 10})
    store.put_state("unrelated", {"value": 1})

    assert store.list_state("oidc_pending:") == [
        ("oidc_pending:a", {"expires_at": 10})
    ]
    assert store.delete_state("oidc_pending:a") is True
    assert store.get_state("oidc_pending:a") is None

    store.put_state("oidc_pending:b", {"expires_at": 20})
    assert store.take_state("oidc_pending:b") == {"expires_at": 20}
    assert store.take_state("oidc_pending:b") is None


def test_change_vector_is_shared_and_only_tracks_cached_domain_collections():
    writer, container = _store()
    reader = AzureBlobStateDatabase(
        container, container="netgravity-state", prefix="state/v1"
    )

    writer.put("rate_limit_windows", "client", {"hits": 1})
    assert reader.change_vector() == {}

    writer.put("projects", "project-1", {"document": {"id": "project-1"}})
    after_project = reader.change_vector()
    assert set(after_project) == {"projects"}

    reader.put("users", "user-1", {"document": {"id": "user-1"}})
    merged = writer.change_vector()
    assert merged["projects"] == after_project["projects"]
    assert merged["users"]

    BlobPersistence(writer).save_network_data("dataset", "project-1", {"rows": 3})
    network_change = reader.change_vector()
    assert network_change["network_data:dataset"]
    assert "network_data" not in network_change


def test_replica_synchronizer_refreshes_changed_groups_once():
    writer, container = _store()
    reader = AzureBlobStateDatabase(
        container, container="netgravity-state", prefix="state/v1"
    )
    refreshed = []
    sync = ReplicaSynchronizer(reader, {
        "users": ("auth", lambda: refreshed.append("auth")),
        "sessions": ("auth", lambda: refreshed.append("auth")),
        "projects": ("projects", lambda: refreshed.append("projects")),
    })

    writer.put("users", "user-1", {})
    writer.put("sessions", "token-1", {})
    writer.put("projects", "project-1", {})

    assert set(sync.sync_if_changed()) == {"auth", "projects"}
    assert refreshed.count("auth") == 1
    assert refreshed.count("projects") == 1
    assert sync.sync_if_changed() == {}

    writer.put("login_attempts", "user-1", {"failures": 1})
    assert sync.sync_if_changed() == {}


def test_replica_synchronizer_refreshes_only_the_changed_network_data_kind():
    writer, container = _store()
    reader = AzureBlobStateDatabase(
        container, container="netgravity-state", prefix="state/v1"
    )
    refreshed = []
    sync = ReplicaSynchronizer(reader, {
        "network_data:dataset": (
            "datasets", lambda: refreshed.append("datasets")
        ),
        "network_data:twin_state": (
            "twin_states", lambda: refreshed.append("twin_states")
        ),
    })

    BlobPersistence(writer).save_network_data("twin_state", "twin-1", {})

    assert set(sync.sync_if_changed()) == {"twin_states"}
    assert refreshed == ["twin_states"]


def test_session_renewal_does_not_broadcast_a_registry_reload():
    store, _ = _store()
    records = BlobPersistence(store)
    records.save_session_record("token", "user-1", 100, 1, 2, 200, "browser")
    issued_version = store.change_vector()["sessions"]

    records.touch_session("token", 120, 20)

    assert store.change_vector()["sessions"] == issued_version
    assert records.load_session_records(10)[0]["expires_at"] == 120
