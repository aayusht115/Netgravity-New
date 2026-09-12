"""Typed persistence accessors backed by :mod:`azure_blob_state`.

The public function signatures mirror ``services.persistence`` so the domain
services do not know or care whether local test data lives in SQLite or an
Azure deployment stores JSON records in Blob Storage.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Tuple


class BlobPersistence:
    def __init__(self, database: Any) -> None:
        self.database = database

    @staticmethod
    def _key(*parts: str) -> str:
        return json.dumps(parts, separators=(",", ":"))

    def _delete_where(self, collection: str, predicate: Any) -> int:
        deleted = 0
        for key, record in self.database.list(collection):
            if predicate(record):
                deleted += int(self.database.delete(collection, key))
        return deleted

    def save_user(self, user_id: str, email: str, document: Dict[str, Any],
                  created_at: float) -> None:
        self.database.put("users", user_id, {
            "email": email.lower(), "document": document, "created_at": created_at,
        })

    def load_users(self) -> List[Dict[str, Any]]:
        return [record["document"] for _, record in self.database.list("users")]

    def save_session(self, token: str, user_id: str, expires_at: float) -> None:
        import time
        now = time.time()
        self.database.put("sessions", token, {
            "token": token, "user_id": user_id, "expires_at": expires_at,
            "created_at": now, "last_seen_at": now,
            "absolute_expiry": None, "client": "",
        })

    def delete_session(self, token: str) -> None:
        self.database.delete("sessions", token)

    def purge_expired_sessions(self, now: float) -> int:
        return self._delete_where(
            "sessions", lambda r: float(r.get("expires_at", 0)) < now
        )

    def load_sessions(self, now: float) -> List[Tuple[str, str, float]]:
        return [(r["token"], r["user_id"], float(r["expires_at"]))
                for _, r in self.database.list("sessions")
                if float(r.get("expires_at", 0)) >= now]

    def save_project(self, project_id: str, owner_id: str,
                     document: Dict[str, Any], updated_at: float) -> None:
        self.database.put("projects", project_id, {
            "owner_id": owner_id, "document": document, "updated_at": updated_at,
        })

    def delete_project(self, project_id: str) -> None:
        self.database.delete("projects", project_id)

    def load_projects(self) -> List[Dict[str, Any]]:
        records = [r for _, r in self.database.list("projects")]
        records.sort(key=lambda r: float(r.get("updated_at", 0)))
        return [r["document"] for r in records]

    def save_snapshot(self, snapshot_id: str, network_id: str,
                      document: Dict[str, Any], created_at: float) -> None:
        self.database.put("snapshots", snapshot_id, {
            "network_id": network_id, "document": document, "created_at": created_at,
        })

    def load_snapshots(self) -> List[Dict[str, Any]]:
        records = [r for _, r in self.database.list("snapshots")]
        records.sort(key=lambda r: float(r.get("created_at", 0)))
        return [r["document"] for r in records]

    def save_scenario_network(self, scenario_id: str, snapshot_id: str,
                              document: Dict[str, Any], created_at: float) -> None:
        self.database.put("scenario_networks", scenario_id, {
            "snapshot_id": snapshot_id, "document": document,
            "created_at": created_at,
        })

    def load_scenario_networks(self) -> List[Dict[str, Any]]:
        records = [r for _, r in self.database.list("scenario_networks")]
        records.sort(key=lambda r: float(r.get("created_at", 0)))
        return [r["document"] for r in records]

    def save_scenario(self, scenario_id: str, project_id: str,
                      document: Dict[str, Any], created_at: float) -> None:
        self.database.put("scenarios", scenario_id, {
            "project_id": project_id, "document": document, "created_at": created_at,
        })

    def delete_scenario(self, scenario_id: str) -> None:
        self.database.delete("scenarios", scenario_id)

    def load_scenarios(self) -> List[Tuple[str, Dict[str, Any]]]:
        records = [r for _, r in self.database.list("scenarios")]
        records.sort(key=lambda r: float(r.get("created_at", 0)))
        return [(r["project_id"], r["document"]) for r in records]

    def save_network_data(self, kind: str, network_id: str, document: Any) -> None:
        self.database.put("network_data", self._key(kind, network_id), {
            "kind": kind, "network_id": network_id, "document": document,
        })

    def load_network_data(self, kind: str) -> Dict[str, Any]:
        return {r["network_id"]: r["document"]
                for _, r in self.database.list("network_data")
                if r.get("kind") == kind}

    def save_analysis(self, snapshot_id: str, data_version: str,
                      document: Dict[str, Any], computed_at: float) -> None:
        self.database.put("analyses", snapshot_id, {
            "data_version": data_version, "document": document,
            "computed_at": computed_at,
        })

    def load_analysis(self, snapshot_id: str,
                      data_version: str) -> Optional[Dict[str, Any]]:
        record = self.database.get("analyses", snapshot_id)
        if not record or record.get("data_version") != data_version:
            return None
        document = dict(record.get("document") or {})
        if not document:
            return None
        document["computed_at"] = record.get("computed_at")
        return document

    def delete_analysis(self, snapshot_id: str) -> None:
        self.database.delete("analyses", snapshot_id)

    def load_all_analyses(self) -> List[Tuple[str, str, Dict[str, Any], float]]:
        return [(snapshot_id, r["data_version"], r["document"],
                 float(r.get("computed_at", 0)))
                for snapshot_id, r in self.database.list("analyses")]

    def record_login_failure(self, identity: str, now: float, window: float,
                             threshold: int, lock_seconds: float) -> Dict[str, Any]:
        def change(record: Optional[Dict[str, Any]]):
            if not record or now - float(record.get("first_failed", 0)) > window:
                failures, first_failed = 1, now
            else:
                failures = int(record.get("failures", 0)) + 1
                first_failed = float(record["first_failed"])
            locked_until = now + lock_seconds if failures >= threshold else None
            result = {"failures": failures, "locked_until": locked_until}
            return ({**result, "first_failed": first_failed, "last_failed": now}, result)
        return self.database.mutate("login_attempts", identity, change)

    def login_lock_state(self, identity: str) -> Optional[Dict[str, Any]]:
        record = self.database.get("login_attempts", identity)
        if not record:
            return None
        return {"failures": int(record["failures"]),
                "locked_until": record.get("locked_until")}

    def clear_login_failures(self, identity: str) -> None:
        self.database.delete("login_attempts", identity)

    def save_password_reset(self, token_hash: str, user_id: str,
                            created_at: float, expires_at: float) -> None:
        self.database.create("password_resets", token_hash, {
            "token_hash": token_hash, "user_id": user_id,
            "created_at": created_at, "expires_at": expires_at, "used_at": None,
        })

    def load_password_reset(self, token_hash: str) -> Optional[Dict[str, Any]]:
        return self.database.get("password_resets", token_hash)

    def consume_password_reset(self, token_hash: str, used_at: float) -> int:
        def change(record: Optional[Dict[str, Any]]):
            if not record or record.get("used_at") is not None:
                return record, 0
            record["used_at"] = used_at
            return record, 1
        return self.database.mutate("password_resets", token_hash, change)

    def invalidate_password_resets(self, user_id: str, used_at: float) -> int:
        changed = 0
        for key, record in self.database.list("password_resets"):
            if record.get("user_id") == user_id and record.get("used_at") is None:
                def consume(current: Optional[Dict[str, Any]]):
                    if not current or current.get("used_at") is not None:
                        return current, 0
                    current["used_at"] = used_at
                    return current, 1
                changed += self.database.mutate("password_resets", key, consume)
        return changed

    def count_recent_password_resets(self, user_id: str, since: float) -> int:
        return sum(1 for _, r in self.database.list("password_resets")
                   if r.get("user_id") == user_id
                   and float(r.get("created_at", 0)) >= since)

    def save_session_record(self, token: str, user_id: str, expires_at: float,
                            created_at: float, last_seen_at: float,
                            absolute_expiry: float, client: str) -> None:
        def change(record: Optional[Dict[str, Any]]):
            if record:
                record.update({"expires_at": expires_at, "last_seen_at": last_seen_at})
            else:
                record = {
                    "token": token, "user_id": user_id, "expires_at": expires_at,
                    "created_at": created_at, "last_seen_at": last_seen_at,
                    "absolute_expiry": absolute_expiry, "client": client,
                }
            return record, None
        self.database.mutate("sessions", token, change)

    def touch_session(self, token: str, expires_at: float,
                      last_seen_at: float) -> None:
        def change(record: Optional[Dict[str, Any]]):
            if record:
                record.update({"expires_at": expires_at, "last_seen_at": last_seen_at})
            return record, None
        # Renewal changes expiry metadata but neither the session identity nor
        # its owner. Publishing a fleet-wide invalidation every minute for each
        # active browser would make all replicas re-list every live session.
        self.database.mutate(
            "sessions", token, change, publish_change=False
        )

    def load_session_records(self, now: float) -> List[Dict[str, Any]]:
        return [r for _, r in self.database.list("sessions")
                if float(r.get("expires_at", 0)) >= now]

    def delete_sessions_for_user(self, user_id: str,
                                 keep_token: str = "") -> int:
        return self._delete_where(
            "sessions",
            lambda r: r.get("user_id") == user_id and r.get("token") != keep_token,
        )

    def save_mfa_enrolment(self, user_id: str, secret: str, created_at: float,
                           confirmed_at: Optional[float]) -> None:
        def change(record: Optional[Dict[str, Any]]):
            last_used_step = None if not record else record.get("last_used_step")
            return {
                "user_id": user_id, "secret": secret, "created_at": created_at,
                "confirmed_at": confirmed_at, "last_used_step": last_used_step,
            }, None
        self.database.mutate("mfa_enrolments", user_id, change)

    def load_mfa_enrolment(self, user_id: str) -> Optional[Dict[str, Any]]:
        return self.database.get("mfa_enrolments", user_id)

    def confirm_mfa_enrolment(self, user_id: str, confirmed_at: float) -> None:
        def change(record: Optional[Dict[str, Any]]):
            if record:
                record["confirmed_at"] = confirmed_at
            return record, None
        self.database.mutate("mfa_enrolments", user_id, change)

    def claim_mfa_step(self, user_id: str, step: int) -> bool:
        def change(record: Optional[Dict[str, Any]]):
            previous = None if not record else record.get("last_used_step")
            if not record or (previous is not None and int(previous) >= step):
                return record, False
            record["last_used_step"] = step
            return record, True
        return self.database.mutate("mfa_enrolments", user_id, change)

    def delete_mfa_enrolment(self, user_id: str) -> None:
        self.database.delete("mfa_enrolments", user_id)
        self._delete_where("mfa_recovery_codes",
                           lambda r: r.get("user_id") == user_id)

    def save_recovery_codes(self, user_id: str,
                            code_hashes: Iterable[str]) -> None:
        self._delete_where("mfa_recovery_codes",
                           lambda r: r.get("user_id") == user_id)
        for code_hash in code_hashes:
            key = self._key(user_id, code_hash)
            self.database.create("mfa_recovery_codes", key, {
                "user_id": user_id, "code_hash": code_hash, "used": False,
            })

    def consume_recovery_code(self, user_id: str, code_hash: str) -> bool:
        key = self._key(user_id, code_hash)
        def change(record: Optional[Dict[str, Any]]):
            if not record or record.get("used"):
                return record, False
            record["used"] = True
            return record, True
        return self.database.mutate("mfa_recovery_codes", key, change)

    def count_unused_recovery_codes(self, user_id: str) -> int:
        return sum(1 for _, r in self.database.list("mfa_recovery_codes")
                   if r.get("user_id") == user_id and not r.get("used"))

    def bump_rate_limit_window(self, bucket: str, client: str, now: float,
                               window_seconds: float) -> Tuple[int, float]:
        key = self._key(bucket, client)
        def change(record: Optional[Dict[str, Any]]):
            if not record or now - float(record.get("window_start", 0)) >= window_seconds:
                record = {"bucket": bucket, "client": client,
                          "window_start": now, "hits": 1}
            else:
                record["hits"] = int(record.get("hits", 0)) + 1
            return record, (int(record["hits"]), float(record["window_start"]))
        return self.database.mutate("rate_limit_windows", key, change)

    def purge_rate_limit_windows(self, older_than: float) -> int:
        return self._delete_where(
            "rate_limit_windows",
            lambda r: float(r.get("window_start", 0)) < older_than,
        )

    def clear_rate_limit_windows(self) -> None:
        self._delete_where("rate_limit_windows", lambda _: True)

    def save_execution_trace(self, execution_id: str, document: Dict[str, Any], *,
                             actor_id: str = "", intent: str = "",
                             workflow: str = "", snapshot_id: str = "",
                             status: str = "", started_at: float = 0.0) -> None:
        self.database.put("execution_traces", execution_id, {
            "actor_id": actor_id, "intent": intent, "workflow": workflow,
            "snapshot_id": snapshot_id, "status": status,
            "started_at": started_at, "document": document,
        })

    def load_execution_trace(self, execution_id: str) -> Optional[Dict[str, Any]]:
        record = self.database.get("execution_traces", execution_id)
        return None if not record else record.get("document")

    def load_execution_traces(self, limit: int = 200,
                              actor_id: Optional[str] = None) -> List[Dict[str, Any]]:
        records = [r for _, r in self.database.list("execution_traces")
                   if not actor_id or r.get("actor_id") == actor_id]
        records.sort(key=lambda r: float(r.get("started_at", 0)), reverse=True)
        return [r["document"] for r in records[:limit]]

    def purge_execution_traces(self, older_than: float) -> int:
        return self._delete_where(
            "execution_traces",
            lambda r: float(r.get("started_at", 0)) < older_than,
        )

    def count_execution_traces(self) -> int:
        return self.database.count("execution_traces")

    def link_federated_identity(self, issuer: str, subject: str, user_id: str,
                                email: str, now: float) -> None:
        key = self._key(issuer, subject)
        def change(record: Optional[Dict[str, Any]]):
            if record:
                record.update({"email": email, "last_seen": now})
            else:
                record = {"issuer": issuer, "subject": subject, "user_id": user_id,
                          "email": email, "created_at": now, "last_seen": now}
            return record, None
        self.database.mutate("federated_identities", key, change)

    def find_federated_identity(self, issuer: str,
                                subject: str) -> Optional[Dict[str, Any]]:
        return self.database.get("federated_identities", self._key(issuer, subject))

    def federated_identities_for(self, user_id: str) -> List[Dict[str, Any]]:
        records = [r for _, r in self.database.list("federated_identities")
                   if r.get("user_id") == user_id]
        records.sort(key=lambda r: float(r.get("created_at", 0)))
        return [{k: v for k, v in r.items() if k != "user_id"} for r in records]

    def unlink_federated_identity(self, issuer: str, subject: str) -> int:
        return int(self.database.delete(
            "federated_identities", self._key(issuer, subject)
        ))


ACCESSOR_NAMES = (
    "save_user", "load_users", "save_session", "delete_session",
    "purge_expired_sessions", "load_sessions", "save_project", "delete_project",
    "load_projects", "save_snapshot", "load_snapshots", "save_scenario_network",
    "load_scenario_networks", "save_scenario", "delete_scenario", "load_scenarios",
    "save_network_data", "load_network_data", "save_analysis", "load_analysis",
    "delete_analysis", "load_all_analyses", "record_login_failure",
    "login_lock_state", "clear_login_failures", "save_password_reset",
    "load_password_reset", "consume_password_reset", "invalidate_password_resets",
    "count_recent_password_resets", "save_session_record", "touch_session",
    "load_session_records", "delete_sessions_for_user", "save_mfa_enrolment",
    "load_mfa_enrolment", "confirm_mfa_enrolment", "claim_mfa_step",
    "delete_mfa_enrolment", "save_recovery_codes", "consume_recovery_code",
    "count_unused_recovery_codes", "bump_rate_limit_window",
    "purge_rate_limit_windows", "clear_rate_limit_windows", "save_execution_trace",
    "load_execution_trace", "load_execution_traces", "purge_execution_traces",
    "count_execution_traces", "link_federated_identity",
    "find_federated_identity", "federated_identities_for",
    "unlink_federated_identity",
)


def accessors_for(database: Any) -> Dict[str, Any]:
    adapter = BlobPersistence(database)
    return {name: getattr(adapter, name) for name in ACCESSOR_NAMES}
