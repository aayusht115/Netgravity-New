"""Facility KPI monitors over versioned authoritative baseline analyses.

This is a deterministic monitoring agent, not live telemetry or an LLM making
up thresholds. Rules run on new uploaded network versions even with no browser
open. Instructions are stored as human context and are never interpreted as
code, a prompt, a recipient, or a replacement for an explicit rule.

The claim to send is persisted BEFORE SMTP. Exactly-once SMTP is not possible:
a crash after acceptance has an unknown outcome. Such claims are never retried
automatically, favouring a visible uncertain delivery over duplicate emails.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import math
import os
import threading
import time
import uuid
from typing import Any, Callable, Optional

from app.backend.services.errors import (
    ConflictError, ForbiddenError, NotFoundError, ValidationError,
)

logger = logging.getLogger(__name__)
PREFIX = "kpi-monitor:"
METRICS = {
    "utilization_pct": ("Average utilisation", "%", "percentage points"),
    "peak_utilization_pct": ("Peak utilisation", "%", "percentage points"),
    "throughput_units": ("Horizon throughput", "units", "units"),
    "throughput_units_per_period": ("Average throughput per period", "units/period", "units/period"),
    "capacity_units": ("Capacity per period", "units", "units"),
}
DIRECTIONS = ("increase", "decrease", "above", "below")
EVALUATION_BASIS = (
    "New authoritative baseline analyses of uploaded network versions; not a "
    "live telemetry feed. The first comparable version establishes a baseline "
    "without email. Increase/decrease use absolute units (percentage points "
    "for utilisation); above/below alert only on crossing the threshold. "
    "Rules are OR'ed. Only the same facility identity, unit and exact labelled "
    "planning horizon are compared. Instructions are context, not executable rules."
)


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def _number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


class MonitorStore:
    """One JSON document per monitor; Blob ETag CAS or local SQL value CAS."""

    def __init__(self, database: Any) -> None:
        self.database = database

    def list(self) -> list[dict]:
        return [value for _, value in self.database.list_state(PREFIX)]

    def get(self, monitor_id: str) -> Optional[dict]:
        return self.database.get_state(PREFIX + monitor_id)

    def mutate(self, monitor_id: str, change: Callable) -> Any:
        key = PREFIX + monitor_id
        if self.database.kind == "azure_blob":
            def blob_change(record):
                current = None if record is None else record.get("value")
                value, result = change(copy.deepcopy(current))
                return None if value is None else {"value": value}, result
            return self.database.mutate("app_state", key, blob_change,
                                        publish_change=False)
        # No new local table or SQL server. The WHERE clause is the compare-
        # and-swap, including across separate Database instances/processes.
        for _ in range(16):
            row = self.database.query_one("SELECT value FROM app_state WHERE key = ?", (key,))
            current = json.loads(row["value"]) if row else None
            value, result = change(copy.deepcopy(current))
            if value is None:
                if row is None:
                    return result
                changed = self.database.execute(
                    "DELETE FROM app_state WHERE key = ? AND value = ?", (key, row["value"]))
            else:
                raw = json.dumps(value, separators=(",", ":"), allow_nan=False)
                if row is None:
                    changed = self.database.execute(
                        "INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
                        (key, raw))
                else:
                    changed = self.database.execute(
                        "UPDATE app_state SET value = ? WHERE key = ? AND value = ?",
                        (raw, key, row["value"]))
            if changed:
                return result
        raise ConflictError("The monitor changed concurrently. Try again.")


def _public(record: dict) -> dict:
    return {k: copy.deepcopy(v) for k, v in record.items()
            if k not in {"owner_id", "generation", "seen_versions", "facility_identity"}}


def _state() -> dict:
    return {"status": "paused", "last_checked_at": None, "last_version": None,
            "current": {}, "previous": {}, "last_alert": None}


def _validate_instructions(instructions: Any) -> str:
    if not isinstance(instructions, str) or len(instructions) > 2000:
        raise ValidationError("Instructions must be text of at most 2,000 characters.")
    return instructions.strip()


def _validate_rules(rules: Any) -> list:
    if not isinstance(rules, list) or not 1 <= len(rules) <= len(METRICS):
        raise ValidationError("Select between one and five KPI rules.")
    selected = set()
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) != {"metric", "direction", "threshold"}:
            raise ValidationError("Each rule requires metric, direction and threshold only.")
        metric, direction, threshold = rule["metric"], rule["direction"], rule["threshold"]
        if not isinstance(metric, str) or metric not in METRICS or metric in selected:
            raise ValidationError("Select each supported metric at most once.")
        if direction not in DIRECTIONS or not _number(threshold) or threshold < 0:
            raise ValidationError("Choose a supported direction and a finite, non-negative threshold.")
        if direction in {"increase", "decrease"} and threshold <= 0:
            raise ValidationError("A change threshold must be greater than zero.")
        selected.add(metric)
    return copy.deepcopy(rules)


class KpiMonitorService:
    def __init__(self, store: MonitorStore, projects: Any, orchestrator: Any,
                 users: Any, analyses: Any, sender: Any, *, sync: Callable = lambda: None,
                 interval: int = 60, clock: Callable = time.time) -> None:
        self.store, self.projects, self.orchestrator = store, projects, orchestrator
        self.users, self.analyses, self.sender = users, analyses, sender
        self.sync, self.interval, self.clock = sync, interval, clock
        self.worker_enabled = False
        self._stop = threading.Event()

    def capabilities(self) -> dict:
        delivery = self.sender.describe()
        # The shared sender only implements SMTP; an API key alone is not a
        # usable transport even though legacy describe() calls it configured.
        if delivery.get("channel") == "api":
            delivery = {"configured": False, "channel": "api_unimplemented",
                        "reason": "Email API delivery is not implemented. Configure SMTP to deliver alerts."}
        return {"metrics": [{"key": key, "label": item[0], "unit": item[1],
                              "change_unit": item[2]} for key, item in METRICS.items()],
                "directions": list(DIRECTIONS), "email_delivery": delivery,
                "worker_enabled": self.worker_enabled,
                "polling_interval_seconds": self.interval,
                "evaluation_basis": EVALUATION_BASIS,
                "max_rules_per_monitor": len(METRICS),
                "recipient_policy": "Authenticated account email only."}

    def _project(self, project_id: str, user_id: str):
        if not isinstance(project_id, str) or not project_id.strip():
            raise ValidationError("A project_id is required.")
        project = self.projects.get(project_id, user_id=user_id)
        if project.owner_id != user_id or project.is_demo:
            raise ForbiddenError("Monitoring is available only on your own non-demo projects.")
        return project

    def _facility(self, project, facility_id):
        if self.orchestrator is None or not project.snapshot_id:
            raise ValidationError("Upload and confirm a network before creating a monitor.")
        snapshot = self.orchestrator.snapshots.get(project.snapshot_id)
        for facility in snapshot.network.facilities:
            if facility.id == facility_id:
                # IDs alone can be reused for a different site on replacement.
                # Capacity is deliberately excluded: it is a monitored KPI.
                return facility, _fingerprint({key: str(getattr(facility, key, ""))
                    for key in ("id", "name", "role", "latitude", "longitude")})
        raise ValidationError("The facility_id is not in this project's current network.")

    def list_for(self, project_id: str, user: Any) -> dict:
        self._project(project_id, user.user_id)
        return {"monitors": [_public(m) for m in self.store.list()
                if m["project_id"] == project_id and m["owner_id"] == user.user_id],
                "capabilities": self.capabilities()}

    def create(self, payload: dict, user: Any) -> dict:
        if not isinstance(payload, dict):
            raise ValidationError("Expected a JSON object.")
        unknown = set(payload) - {"project_id", "facility_id", "rules", "instructions", "enabled", "recipient"}
        if unknown:
            raise ValidationError("Unsupported monitor fields: " + ", ".join(sorted(unknown)))
        project = self._project(payload.get("project_id"), user.user_id)
        facility_id = payload.get("facility_id")
        if not isinstance(facility_id, str) or not facility_id.strip():
            raise ValidationError("A facility_id is required.")
        facility, identity = self._facility(project, facility_id)
        recipient = str(payload.get("recipient") or user.email).strip().lower()
        if recipient != user.email.strip().lower() or "@" not in recipient or any(c in recipient for c in "\r\n"):
            raise ValidationError("Alerts may only be sent to your current account email.")
        enabled = payload.get("enabled", False)
        if not isinstance(enabled, bool):
            raise ValidationError("enabled must be a boolean.")
        instructions = _validate_instructions(payload.get("instructions", ""))
        rules = _validate_rules(payload.get("rules"))
        monitor_id = _fingerprint([user.user_id, project.project_id, facility_id])[:32]
        record = {"id": monitor_id, "owner_id": user.user_id,
                  "project_id": project.project_id, "facility_id": facility_id,
                  "facility_name": str(getattr(facility, "name", "") or facility_id),
                  "facility_identity": identity, "recipient": recipient,
                  "instructions": instructions.strip(), "rules": copy.deepcopy(rules),
                  "enabled": enabled, "created_at": self.clock(), "updated_at": self.clock(),
                  "generation": uuid.uuid4().hex, "seen_versions": [], "state": _state()}
        record["state"]["status"] = "awaiting_baseline" if enabled else "paused"
        def create_once(current):
            if current:
                raise ConflictError("This facility already has a monitor. Pause or resume that monitor.")
            return record, _public(record)
        return self.store.mutate(monitor_id, create_once)

    def set_enabled(self, monitor_id: str, project_id: str, enabled: bool, user: Any) -> dict:
        return self.update(monitor_id, project_id, {"enabled": enabled}, user)

    def update(self, monitor_id: str, project_id: str, changes: dict, user: Any) -> dict:
        project = self._project(project_id, user.user_id)
        if not changes or set(changes) - {"enabled", "rules", "instructions"}:
            raise ValidationError("Provide enabled, rules or instructions to update the monitor.")
        if "enabled" in changes and not isinstance(changes["enabled"], bool):
            raise ValidationError("enabled must be a boolean.")
        if "rules" in changes:
            changes["rules"] = _validate_rules(changes["rules"])
        if "instructions" in changes:
            changes["instructions"] = _validate_instructions(changes["instructions"])
        def update(current):
            if not current:
                raise NotFoundError("Monitor not found.")
            if current["owner_id"] != user.user_id or current["project_id"] != project_id:
                raise ForbiddenError("This monitor is not in your project.")
            changed = any(current[key] != value for key, value in changes.items())
            enabled = changes.get("enabled", current["enabled"])
            rules_changed = "rules" in changes and changes["rules"] != current["rules"]
            reset = rules_changed or (enabled and not current["enabled"])
            if changed:
                if enabled and reset:
                    facility, identity = self._facility(project, current["facility_id"])
                    current["facility_identity"] = identity
                    current["facility_name"] = str(facility.name or current["facility_id"])
                    current["recipient"] = user.email.strip().lower()
                if reset:
                    current["state"]["current"] = {}
                    current["state"]["previous"] = {}
                current.update(copy.deepcopy(changes))
                current["generation"] = uuid.uuid4().hex
                if not enabled or reset:
                    current["state"]["status"] = "awaiting_baseline" if enabled else "paused"
                current["updated_at"] = self.clock()
            return current, _public(current)
        return self.store.mutate(monitor_id, update)

    def _analysis(self, project, snapshot):
        def compute():
            from app.backend.services.analysis_store import serialise_analysis
            from netgravity.orchestrator.metrics.registry import KPIRegistry
            from netgravity.orchestrator.schemas.requests import Actor, ActorRole, Intent, OrchestratorRequest
            response = self.orchestrator.run_sync(OrchestratorRequest(
                input="Authoritative network KPI baseline execution",
                explicit_intent=Intent.NETWORK_STATE_QUERY,
                actor=Actor(actor_id=project.owner_id, role=ActorRole.PLANNER),
                network_snapshot_id=snapshot.snapshot_id, disable_llm=True,
                request_id="kpi-monitor-" + uuid.uuid4().hex))
            ctx = self.orchestrator.get_execution_state(response.execution_id)
            if ctx is None:
                raise RuntimeError("The authoritative baseline produced no execution context.")
            return serialise_analysis(KPIRegistry(), ctx)
        return self.analyses.get(snapshot.snapshot_id, snapshot.data_version, compute)

    def _status(self, monitor: dict, status: str, *, disable=False, clear=False):
        def update(current):
            if current and current["generation"] == monitor["generation"] and current["enabled"]:
                current["state"].update(status=status, last_checked_at=self.clock())
                if disable:
                    current["enabled"] = False
                if clear:
                    current["state"]["current"] = {}
                    current["state"]["previous"] = {}
            return current, None
        self.store.mutate(monitor["id"], update)

    @staticmethod
    def _measurements(analysis, monitor):
        horizon = analysis.get("horizon") or {}
        horizon = {key: horizon.get(key) for key in
                   ("periods_modelled", "period_labels", "first_period", "last_period")}
        if not horizon["period_labels"] and not (horizon["first_period"] and horizon["last_period"]):
            return {}, "horizon_unavailable"
        signature = _fingerprint(horizon)
        available = {}
        facilities = analysis.get("facilities") or {}
        for rule in monitor["rules"]:
            key = rule["metric"]
            metric = (facilities.get(monitor["facility_id"]) or {}).get(key) or {}
            if (metric.get("status") != "VALID" or not _number(metric.get("value"))
                    or metric.get("unit") != METRICS[key][1]
                    or metric.get("entity_id") != monitor["facility_id"]
                    or metric.get("scope") != "FACILITY" or metric.get("scenario_id")):
                continue
            available[key] = {"value": metric["value"], "unit": metric["unit"],
                              "horizon": horizon, "horizon_signature": signature,
                              "version": analysis["data_version"]}
        return available, "current" if len(available) == len(monitor["rules"]) else "missing_data"

    @staticmethod
    def _matches(rule, previous, current):
        if not previous or previous["horizon_signature"] != current["horizon_signature"] or previous["unit"] != current["unit"]:
            return False
        old, new, threshold = previous["value"], current["value"], rule["threshold"]
        return {"increase": new - old >= threshold, "decrease": old - new >= threshold,
                "above": old <= threshold < new, "below": new < threshold <= old}[rule["direction"]]

    def evaluate(self, monitor: dict) -> None:
        if not monitor["enabled"]:
            return
        try:
            project = self._project(monitor["project_id"], monitor["owner_id"])
        except (ForbiddenError, NotFoundError):
            self._status(monitor, "project_unavailable", disable=True, clear=True)
            return
        user = self.users.get_user(monitor["owner_id"])
        if not user or user.email.strip().lower() != monitor["recipient"]:
            self._status(monitor, "account_changed", disable=True, clear=True)
            return
        if not project.snapshot_id:
            self._status(monitor, "awaiting_network", clear=True)
            return
        try:
            _, identity = self._facility(project, monitor["facility_id"])
        except ValidationError:
            self._status(monitor, "facility_unavailable", disable=True, clear=True)
            return
        if identity != monitor["facility_identity"]:
            self._status(monitor, "facility_identity_changed", disable=True, clear=True)
            return
        snapshot = self.orchestrator.snapshots.get(project.snapshot_id)
        if snapshot.is_hypothetical:
            self._status(monitor, "hypothetical_data_refused", clear=True)
            return
        analysis = self._analysis(project, snapshot)
        if analysis.get("data_version") != snapshot.data_version:
            self._status(monitor, "analysis_version_mismatch")
            return
        measurements, status = self._measurements(analysis, monitor)
        version = snapshot.data_version
        # Re-read durable binding/ownership after a potentially long solve.
        self.sync()
        latest = self._project(monitor["project_id"], monitor["owner_id"])
        if latest.snapshot_id != snapshot.snapshot_id:
            self._status(monitor, "newer_data_pending")
            return
        now = self.clock()
        def claim(current):
            if not current or not current["enabled"] or current["generation"] != monitor["generation"]:
                return current, None
            state = current["state"]
            state["last_checked_at"] = now
            if version in current["seen_versions"] and version != state["last_version"]:
                # Rebinding an old upload is not a fresh measurement. Clear
                # comparisons so a later version cannot appear to "change"
                # just because the project's binding moved backwards.
                state.update(status="previous_version_rebound", current={}, previous={},
                             last_version=version, snapshot_id=snapshot.snapshot_id)
                return current, None
            if version in current["seen_versions"] and state["current"]:
                return current, None
            previous = state["current"]
            fresh = version not in current["seen_versions"]
            matches = [{"metric": rule["metric"], "direction": rule["direction"],
                        "threshold": rule["threshold"], "previous": previous[rule["metric"]],
                        "current": measurements[rule["metric"]]}
                       for rule in current["rules"] if fresh and rule["metric"] in measurements
                       and self._matches(rule, previous.get(rule["metric"]), measurements[rule["metric"]])]
            state.update(previous=previous, current=measurements, last_version=version,
                         snapshot_id=snapshot.snapshot_id, computed_at=analysis.get("computed_at"),
                         status="baseline_established" if measurements and not previous else status)
            if fresh:
                current["seen_versions"].append(version)
            if not matches:
                return current, None
            alert = {"id": uuid.uuid4().hex, "created_at": now, "version": version,
                     "status": "delivery_uncertain", "matches": matches,
                     "note": "Delivery was claimed. If completion is not recorded, its outcome is unknown; automatic retry is disabled."}
            state["last_alert"] = alert
            return current, copy.deepcopy(alert)
        alert = self.store.mutate(monitor["id"], claim)
        if alert is None:
            return
        # A pause/deletion immediately after a claim should suppress sending.
        current = self.store.get(monitor["id"])
        self.sync()
        try:
            still_project = self._project(monitor["project_id"], monitor["owner_id"])
            still_user = self.users.get_user(monitor["owner_id"])
            allowed = (current and current["enabled"] and current["generation"] == monitor["generation"]
                       and still_project.snapshot_id == snapshot.snapshot_id and still_user
                       and still_user.email.strip().lower() == monitor["recipient"])
        except (ForbiddenError, NotFoundError):
            allowed = False
        if not allowed:
            outcome, note = "cancelled", "The monitor or project changed before dispatch; no email was sent."
        elif not self.capabilities()["email_delivery"].get("configured"):
            outcome, note = "stubbed", "No supported outbound mail server is configured; no email was sent."
        else:
            body = [f"Facility: {monitor['facility_name']} ({monitor['facility_id']})",
                    f"Project: {project.name} ({project.project_id})", f"Data version: {version}",
                    "Source: authoritative uploaded-network baseline, not live telemetry.", ""]
            for match in alert["matches"]:
                old, new = match["previous"], match["current"]
                body.append(f"{METRICS[match['metric']][0]}: {old['value']:g} -> {new['value']:g} {new['unit']}. "
                            f"Rule: {match['direction']} {match['threshold']:g}; planning horizon: {new['horizon']}.")
            if monitor["instructions"]:
                body.extend(["", "Your saved context (not an executable rule):", monitor["instructions"]])
            body.extend(["", "Review allocation, capacity and service trade-offs in Scenario Planner before changing the network."])
            try:
                result = self.sender.send(to=[monitor["recipient"]],
                    subject="NetGravity KPI alert: " + monitor["facility_id"].replace("\r", "").replace("\n", ""),
                    body="\n".join(body))
                if result.outcome == "sent":
                    outcome, note = "sent", "Accepted by the mail server. Inbox delivery is not confirmed."
                elif result.outcome == "stubbed":
                    outcome, note = "stubbed", "Email delivery was stubbed; no email was sent."
                elif result.refused:
                    outcome, note = "failed", "The mail server refused the account address; no automatic retry."
                else:
                    outcome, note = "delivery_uncertain", "The mail send failed. Acceptance may be unknown; no automatic retry."
            except Exception:
                logger.exception("kpi_monitor.email_failed monitor=%s", monitor["id"])
                outcome, note = "delivery_uncertain", "The mail send raised an error; delivery is unknown and no automatic retry will occur."
        def finish(current):
            last = current and current["state"].get("last_alert")
            if last and last["id"] == alert["id"]:
                last.update(status=outcome, note=note, completed_at=self.clock())
            return current, None
        self.store.mutate(monitor["id"], finish)

    def run_once(self) -> None:
        self.sync()
        for monitor in self.store.list():
            if self._stop.is_set():
                break
            try:
                self.evaluate(monitor)
            except Exception:
                logger.exception("kpi_monitor.evaluation_failed monitor=%s", monitor.get("id"))
                self._status(monitor, "evaluation_failed")

    def start(self) -> None:
        if self.worker_enabled:
            return
        self.worker_enabled = True
        def loop():
            # Startup has no user-authorised monitors on a fresh deployment.
            while not self._stop.wait(self.interval):
                try:
                    self.run_once()
                except Exception:
                    logger.exception("kpi_monitor.poll_failed")
        threading.Thread(target=loop, name="netgravity-kpi-monitors", daemon=True).start()


def build_service(orchestrator, *, app=None) -> KpiMonitorService:
    from app.backend.services import persistence
    from app.backend.services.analysis_store import analysis_service
    from app.backend.services.project_registry import project_registry
    from app.backend.services.security import auth_service
    from netgravity.action_agent.email_sender import EmailSender
    def sync():
        synchronizer = app and app.extensions.get("netgravity_replica_sync")
        if synchronizer:
            synchronizer.sync_if_changed()
    try:
        interval = int(os.environ.get("NETGRAVITY_KPI_MONITOR_INTERVAL_SECONDS", "60"))
    except ValueError:
        interval = 60
    return KpiMonitorService(MonitorStore(persistence.database), project_registry,
        orchestrator, auth_service, analysis_service, EmailSender(), sync=sync,
        interval=max(30, min(3600, interval)))


def install_worker(app, service) -> dict:
    production = os.environ.get("NETGRAVITY_ENV", "development").lower() == "production"
    enabled = os.environ.get("NETGRAVITY_KPI_MONITOR_WORKER", "true" if production else "false").lower() in {"1", "true", "yes"}
    if enabled and service.orchestrator is not None:
        service.start()
    app.extensions["netgravity_kpi_monitors"] = service
    return {"enabled": service.worker_enabled, "polling_interval_seconds": service.interval,
            "evaluation_basis": EVALUATION_BASIS}
