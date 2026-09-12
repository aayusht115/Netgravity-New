"""Authenticated, project-owned facility KPI monitoring controls."""
from flask import Blueprint, g, jsonify, request

from app.backend.services.errors import ValidationError
from app.backend.services.ratelimit import rate_limit
from app.backend.services.security import require_auth


def create_kpi_monitors_blueprint(service):
    bp = Blueprint("kpi_monitors", __name__, url_prefix="/api/kpi-monitors")

    @bp.route("", methods=["GET"])
    @require_auth
    @rate_limit("kpi_monitors.read", limit=120, window_seconds=60)
    def list_monitors():
        return jsonify(service.list_for(request.args.get("project_id", ""), g.current_user))

    @bp.route("", methods=["POST"])
    @require_auth
    @rate_limit("kpi_monitors.write", limit=20, window_seconds=60)
    def create_monitor():
        return jsonify({"monitor": service.create(request.get_json(silent=True), g.current_user),
                        "capabilities": service.capabilities()}), 201

    @bp.route("/<monitor_id>", methods=["PATCH"])
    @require_auth
    @rate_limit("kpi_monitors.write", limit=30, window_seconds=60)
    def change_monitor(monitor_id):
        body = request.get_json(silent=True)
        if (not isinstance(body, dict) or "project_id" not in body
                or len(body) < 2 or set(body) - {"project_id", "enabled", "rules", "instructions"}):
            raise ValidationError("Provide project_id and at least one of enabled, rules or instructions.")
        changes = {key: value for key, value in body.items() if key != "project_id"}
        return jsonify({"monitor": service.update(monitor_id, body["project_id"],
                                                  changes, g.current_user),
                        "capabilities": service.capabilities()})

    return bp
