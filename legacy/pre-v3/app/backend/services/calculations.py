"""Inspectable calculations from immutable, captured engine runs.

Formulas describe the existing engine; this module never solves a network or
fits a replacement forecast. All raw inputs and outputs remain downloadable.
"""
from __future__ import annotations

from datetime import datetime, timezone
import math


COST_LABELS = {
    "facility_cost": "Fixed facility operating cost", "opening_cost": "Site opening cost",
    "closure_cost": "Site closure cost", "transport_cost": "Transport cost",
    "handling_cost": "Handling cost", "inventory_cost": "Inventory cost",
    "holding_cost": "Stock holding cost", "carbon_cost": "Priced carbon cost",
    "shortage_cost": "Shortage penalty",
}

COST_METHODS = {
    "facility_cost": "For each open site: fixed operating rate converted to the configured cost period × number of modeled periods. Sum across sites.",
    "opening_cost": "Sum each site's one-time opening cost only where the solved site is open and the input marks it as a candidate.",
    "closure_cost": "Sum one-time closure cost only for eligible existing sites that the selected optimization mode closes; unselected candidates do not incur a closure charge.",
    "transport_cost": "For every origin–destination–mode–product–period flow: flow units × lane rate per unit. Sum these line items; lane rates are not multiplied by distance again.",
    "handling_cost": "For every open site: outbound flow units × its handling rate per unit. Sum across sites and periods.",
    "inventory_cost": "Use the inventory coefficients captured before this solve. Safety stock = z × demand standard deviation × sqrt(replenishment plus lane lead time / days per planning period). Cycle stock = 0.5 × demand × lead time / days per period when enabled. Stock cost = stock units × product value × period-normalized holding rate. Divide by the coefficient's demand quantity to obtain cost per flow unit, then multiply by solved flow. The legacy pair-only coefficient is charged once per active pair. The engine uses the last demand row for each market/product when forming coefficients; all rows and the actual coefficients are preserved below.",
    "holding_cost": "Stock carried between periods × product unit value × annual holding rate × days per period / 365. This is separate from the safety/cycle-stock inventory term. Inclusion in business cost follows the recorded cost basis, not this report.",
    "carbon_cost": "Solved transport carbon × configured carbon price when priced. The solver may also add a weighted-carbon preference term; the business cost basis determines whether a carbon term represents an actual priced cost.",
    "shortage_cost": "Per market/product/period: unserved units × shortage penalty × (1 + (demand priority − 1) × 0.5). This is a solver penalty, excluded from business cost unless explicitly included by the run's cost basis.",
}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def valid(kpis, key):
    item = kpis.get(key) or {}
    return item.get("value") if item.get("status") == "VALID" and number(item.get("value")) else None


def metric(key, label, value, unit, formula, inputs, note=""):
    return {"id": key, "label": label, "value": value, "unit": unit,
            "formula": formula, "inputs": inputs, "note": note,
            "status": "VALID" if value is not None else "UNAVAILABLE"}


def cost_components(state, trace):
    costs = state.get("costs") or {}
    original = (trace.get("solver_output") or {}).get("objective_components") or {}
    authoritative = costs.get("component_values") or {}
    included = costs.get("included_components") or []
    return [{"id": key, "label": label,
             "value": authoritative.get(key, original.get(key, costs.get(key))), "included": key in included}
            for key, label in COST_LABELS.items()]


def network_report(analysis, *, project_id, snapshot_id, label="Current baseline"):
    state = analysis.get("calculation_state") or {}
    trace = analysis.get("calculation_trace") or {}
    kpis = analysis.get("kpis") or {}
    components = cost_components(state, trace)
    facilities = state.get("facilities") or []
    open_capacity = [f for f in facilities if f.get("is_open") and number(f.get("capacity_units")) and f["capacity_units"] > 0]
    service = state.get("service") or {}
    rows = [
        metric("business_network_cost", "Total network cost", valid(kpis, "business_network_cost"), analysis.get("currency"),
               "Sum of cost components included by this run's business cost basis", components,
               "Components marked excluded do not contribute to this total. A shortage penalty is included only when the run's business cost basis explicitly includes it."),
        metric("avg_utilization_pct", "Average utilisation", valid(kpis, "avg_utilization_pct"), "%",
               "Sum of utilisation percentages of open facilities with positive capacity / number of those facilities",
               [{"facility_id": f.get("facility_id"), "facility_name": f.get("facility_name"),
                 "throughput": f.get("throughput_units"), "capacity": f.get("capacity_units"),
                 "utilisation_percent": f.get("utilization_pct")} for f in open_capacity],
               "This is the engine's unweighted average of site utilisation, not total throughput divided by total network capacity. Site utilisation = throughput / capacity × 100 over the same horizon."),
        metric("pct_demand_in_sla", "Demand within service level", valid(kpis, "pct_demand_in_sla"), "%",
               "Demand delivered within the configured transit-time service limit / total demand × 100",
               {"demand_within_sla": service.get("demand_within_sla"), "total_demand": service.get("total_demand"),
                "service_methodology": service.get("methodology"), "sla_mode": service.get("sla_mode")},
               "The source section includes the actual service report, demand terms and every solved flow. If total demand is zero, the existing engine reports 100% by convention; this is not measured service performance."),
        metric("total_carbon_kg", "Transport emissions", valid(kpis, "total_carbon_kg"), "kg CO2e",
               "Sum of carbon_kg across all solved flows; displayed tonnes = kilograms / 1000",
               [{"origin": f.get("origin_id"), "destination": f.get("destination_id"), "units": f.get("flow_units"),
                 "carbon_kg": f.get("carbon_kg")} for f in state.get("flows", [])],
               "Emissions use the input mode factors and solved volume. A zero factor in uploaded data is not evidence of zero physical emissions."),
    ]
    other_formulas = {
        "demand_fill_rate": "Served demand / total demand; zero-demand convention = 1",
        "max_utilization_pct": "Maximum horizon utilisation among open facilities with positive capacity",
        "total_demand": "Sum of uploaded demand quantities over the modeled horizon",
        "served_demand": "Sum of deliveries to demand markets over the modeled horizon",
        "unserved_demand": "max(0, total demand − served demand)",
        "n_facilities_open": "Count of facilities whose solved is_open is true",
        "n_facilities_closed": "Count of facilities whose solved is_open is false; this does not by itself establish physical closure",
        "solver_objective": "Sum of the configured mathematical objective terms, including any shortage penalty",
        "shortage_penalty_cost": COST_METHODS["shortage_cost"],
        "min_utilization_pct": "Minimum horizon utilisation among open facilities with positive capacity",
        "periods_modelled": "Count of the distinct periods carried by the actual solve; apply the recorded period-collapse policy first",
        "cost_per_period": "Reported business network cost / number of modeled periods",
        "weighted_avg_distance_km": "Sum(flow units × distance km) / sum(flow units), across all positive solved flows",
        "inbound_avg_distance_km": "Sum(flow units × distance km) / sum(flow units), for Plant/Supplier-to-non-market flows",
        "outbound_avg_distance_km": "Sum(flow units × distance km) / sum(flow units), for flows whose destination is a Market/Customer",
        "carbon_per_unit": "Total transport carbon kg / total served demand units; the existing engine returns zero if no demand is served",
    }
    existing = {r["id"] for r in rows}
    selected_costs = [c for c in components if c["included"]]
    if selected_costs and all(number(c["value"]) for c in selected_costs):
        recomposed = sum(c["value"] for c in selected_costs)
        rows[0]["worked"] = " + ".join(str(c["value"]) for c in selected_costs) + f" = {recomposed}"
        rows[0]["reconciliation_difference"] = recomposed - rows[0]["value"] if number(rows[0]["value"]) else None
    if open_capacity:
        rows[1]["worked"] = "(" + " + ".join(str(f["utilization_pct"]) for f in open_capacity) + f") / {len(open_capacity)} = {rows[1]['value']}% (engine-rounded)"
    if number(service.get("demand_within_sla")) and number(service.get("total_demand")) and service["total_demand"] > 0:
        rows[2]["worked"] = f"{service['demand_within_sla']} / {service['total_demand']} × 100 = {rows[2]['value']}%"
    if number(rows[3]["value"]):
        rows[3]["worked"] = " + ".join(str(f.get("carbon_kg")) for f in state.get("flows", [])) + f" = {rows[3]['value']} kg"
    for key, item in kpis.items():
        if key in existing:
            continue
        formula = other_formulas.get(key)
        if key in COST_LABELS:
            formula = "Sum of this component's line items in the captured solver output; apply the recorded rates and run configuration"
        rows.append(metric(key, COST_LABELS.get(key, key.replace("_", " ").capitalize()),
                           valid(kpis, key), item.get("unit"),
                           formula or f"Authoritative formula {item.get('formula_id', 'not recorded')}; see the captured source and its provenance",
                           {"authoritative_result": item},
                           "Unavailable inputs remain unavailable; the report does not substitute assumptions."))
    solver = trace.get("solver_output") or {}
    raw_network = trace.get("network_inputs") or {}
    role = {f["id"]: f.get("role") for f in raw_network.get("facilities", [])}
    positive = [f for f in solver.get("flow_decisions", []) if number(f.get("flow_units")) and f["flow_units"] > 1e-6]
    market_roles = {"MARKET", "CUSTOMER"}
    outbound = [f for f in positive if role.get(f.get("destination_id")) in market_roles]
    inbound = [f for f in positive if role.get(f.get("origin_id")) in {"PLANT", "SUPPLIER"}
               and role.get(f.get("destination_id")) not in market_roles]
    distance_flows = {"weighted_avg_distance_km": positive, "inbound_avg_distance_km": inbound,
                      "outbound_avg_distance_km": outbound}
    for row in rows:
        key = row["id"]
        if key in distance_flows:
            flows = distance_flows[key]
            numerator = sum(f["flow_units"] * f["distance_km"] for f in flows)
            denominator = sum(f["flow_units"] for f in flows)
            row["inputs"] = flows
            row["worked"] = f"{numerator} flow-unit-km / {denominator} flow units = {row['value']} km (engine-rounded)" if denominator else "No positive flows: the existing engine reports 0 km by convention, not a measured distance."
        elif key in {"min_utilization_pct", "max_utilization_pct"}:
            row["inputs"] = rows[1]["inputs"]
            row["worked"] = f"{'min' if key.startswith('min') else 'max'}({', '.join(str(f['utilization_pct']) for f in open_capacity)}) = {row['value']}%" if open_capacity else "No eligible facilities: the engine uses its zero-utilisation convention."
        elif key in {"n_facilities_open", "n_facilities_closed"}:
            row["label"] = "Active sites" if key.endswith("open") else "Inactive sites in the plan"
            row["inputs"] = [{"id": f.get("facility_id"), "name": f.get("facility_name"), "is_open": f.get("is_open")} for f in facilities]
        elif key in {"total_demand", "periods_modelled"}:
            row["inputs"] = {"demand_rows": raw_network.get("demands"), "period_policy_and_result": solver.get("period_report")}
        elif key == "served_demand":
            row["inputs"] = outbound
        elif key in {"unserved_demand", "demand_fill_rate"}:
            total, served = valid(kpis, "total_demand"), valid(kpis, "served_demand")
            row["inputs"] = {"total_demand": total, "served_demand": served}
            if number(total) and number(served):
                row["worked"] = f"max(0, {total} − {served}) = {row['value']}" if key == "unserved_demand" else (f"{served} / {total} = {row['value']}" if total else "Zero demand: the engine reports a fill rate of 1 by convention.")
        elif key == "cost_per_period":
            periods = state.get("periods_modelled")
            row["inputs"] = {"business_cost": rows[0]["value"], "modeled_periods": periods}
            row["worked"] = f"{rows[0]['value']} / {periods} = {row['value']}"
        elif key in {"solver_objective", "shortage_penalty_cost"}:
            row["inputs"] = {"objective_components": solver.get("objective_components"), "run_configuration": trace.get("run_config"), "solver_metadata": solver.get("solver")}
        elif key == "carbon_per_unit":
            row["inputs"] = {"carbon_kg": rows[3]["value"], "served_units": valid(kpis, "served_demand")}
            row["worked"] = f"{rows[3]['value']} / {valid(kpis, 'served_demand')} = {row['value']} kg/unit (engine-rounded)" if valid(kpis, "served_demand") else "No demand served: zero intensity is the engine's convention, not a measured emissions rate."
    facility_fields = {"facility_cost": "fixed_cost", "opening_cost": "opening_cost",
                       "closure_cost": "closure_cost", "handling_cost": "handling_cost"}
    for component in components:
        key = component["id"]
        row = next((item for item in rows if item["id"] == key), None)
        if row is None:
            row = metric(key, component["label"], component["value"], analysis.get("currency"), "", {})
            rows.append(row)
        row["formula"] = COST_METHODS[key]
        row["note"] = ("Included in" if component["included"] else "Excluded from") + " the reported total network cost. Sources retain the complete input rates, decisions and run configuration."
        if key in facility_fields:
            field = facility_fields[key]
            row["inputs"] = [{"facility_id": f.get("facility_id"), "facility_name": f.get("facility_name"),
                              "is_open": f.get("is_open"), "component_cost": f.get(field)}
                             for f in solver.get("facility_decisions", [])]
        elif key == "transport_cost":
            row["inputs"] = solver.get("flow_decisions", [])
        elif key in {"inventory_cost", "holding_cost"}:
            row["inputs"] = {"coefficients": trace.get("engine_parameters"),
                             "stock_decisions": solver.get("inventory_decisions", []),
                             "reported_component": component["value"]}
        else:
            row["inputs"] = {"run_config": trace.get("run_config"), "reported_component": component["value"],
                             "solver_component": (solver.get("objective_components") or {}).get(key)}
    return {
        "schema_version": 1, "kind": "network", "title": label + " calculations",
        "project_id": project_id, "snapshot_id": snapshot_id,
        "execution_id": analysis.get("execution_id"), "computed_at": analysis.get("computed_at"),
        "scope": {"name": label, "currency": analysis.get("currency"), "horizon": analysis.get("horizon"),
                  "optimization_mode": state.get("optimization_mode"), "hypothetical": state.get("is_hypothetical")},
        "methodology": ["Python optimization and KPI engines calculate these results from the captured network and run configuration. AI does not calculate or alter them.",
                        state.get("mode_description") or "The optimization mode was not recorded.",
                        "Raw precision is retained in the source records. Summary KPIs may be rounded by the owning engine; presentation rounding is not a new calculation."],
        "metrics": rows, "cost_components": components,
        "sources": {"input_and_solver_trace": trace, "reported_state": state, "authoritative_kpis": kpis},
        "limitations": ([] if trace else ["This saved run predates detailed calculation capture. Its reported KPIs are available, but a complete line-item audit requires a new run; no run is substituted automatically."]),
    }


def forecast_report(row, *, project_id, snapshot_id, execution_id, horizon, warnings=()):
    points = row.get("points") or []
    history = row.get("history") or []
    complete = row.get("status") == "OK" and len(points) == horizon and all(number(p.get("mean")) for p in points)
    total = sum(p["mean"] for p in points) if complete else None
    recent_rows = history[-horizon:]
    recent = sum(p["quantity"] for p in recent_rows) if len(recent_rows) == horizon and all(number(p.get("quantity")) for p in recent_rows) else None
    growth = (total / recent - 1) * 100 if total is not None and recent is not None and recent > 0 else None
    peak = max(points, key=lambda p: p["mean"]) if complete else {}
    trace = row.get("calculation_trace") or {}
    accuracy = row.get("accuracy") or {}
    backtest = accuracy.get("calculation_trace") or {}
    error_totals = {key: value for key, value in backtest.items() if key != "folds"}
    error_totals["test_errors"] = [{key: value for key, value in fold.items() if key != "fitted_model"}
                                  for fold in backtest.get("folds", [])]
    metrics = [
        metric("forecast_total", "Forecast demand", total, "units", "Sum of mean forecast demand across the selected horizon", points),
        metric("forecast_growth", "Change versus recent history", growth, "%", "(Forecast total / equal-length recent historical total − 1) × 100",
               {"forecast_total": total, "recent_total": recent, "recent_history": recent_rows}, "Undefined when recent demand is zero or the history is shorter than the selected horizon. This is not a year-on-year comparison."),
        metric("forecast_peak", "Peak forecast demand", peak.get("mean"), "units", "Maximum mean forecast demand within this horizon", {"peak_period": peak.get("period"), "points": points}),
        metric("forecast_range", "Range in peak period", [peak.get("p10"), peak.get("p90")] if peak else None, "units",
               "Read p10 and p90 from the period with the largest mean forecast", peak,
               "These are per-period bounds, not a sum of quantiles or a guaranteed capacity limit."),
        metric("wape", "Backtest error WAPE", accuracy.get("wape") * 100 if number(accuracy.get("wape")) else None, "%",
               "Sum of absolute test errors / sum of absolute observed test demand × 100", error_totals),
        metric("mase", "Error relative to last-observation benchmark", accuracy.get("mase"), "ratio",
               "Mean absolute forecast test error / mean absolute naive test error", {key: value for key, value in error_totals.items() if key != "test_errors"},
               "Naive prediction repeats the last observation. Below 1 beats that benchmark; it does not guarantee low absolute error. A perfect naive benchmark makes the ratio undefined."),
    ]
    if complete:
        metrics[0]["worked"] = " + ".join(str(p["mean"]) for p in points) + f" = {total} units"
        if growth is not None:
            metrics[1]["worked"] = f"({total} / {recent} − 1) × 100 = {growth}%"
        metrics[2]["worked"] = f"max({', '.join(str(p['mean']) for p in points)}) = {peak['mean']} in period {peak['period']}"
    bt = accuracy.get("calculation_trace") or {}
    if number(accuracy.get("wape")):
        metrics[4]["worked"] = f"{bt.get('total_absolute_error')} / {bt.get('total_actual')} × 100 = {accuracy['wape'] * 100}% (engine-rounded)"
    if number(accuracy.get("mase")):
        metrics[5]["worked"] = f"{bt.get('mae_unrounded')} / {bt.get('naive_mae')} = {accuracy['mase']} (engine-rounded)"
    return {"schema_version": 1, "kind": "forecast", "title": "Demand forecast calculations",
            "project_id": project_id, "snapshot_id": snapshot_id, "execution_id": execution_id,
            "computed_at": datetime.now(timezone.utc).isoformat(),
            "scope": {"series": f"{row['market_id']}/{row['product_id']}", "horizon": horizon,
                      "frequency": row.get("frequency"), "engine": row.get("engine"), "engine_version": row.get("engine_version")},
            "methodology": ["The selected statistical engine fits the recorded history; GPT does not predict quantities.",
                            (trace.get("diagnostics") or {}).get("methodology", "The engine did not record a detailed method for this result."),
                            "Model validation uses rolling-origin held-out observations. Signal changes are explicit assumptions, shown separately from the history-only forecast."],
            "metrics": metrics, "sources": {"series": row},
            "limitations": list(row.get("warnings") or []) + list(warnings)}


def scenario_report(record):
    reports = record.get("calculation_reports") or {}
    location = ((reports.get("scenario") or {}).get("sources", {}).get("input_and_solver_trace", {})
                .get("scenario_input_transformations", {}).get("relocation")) or record.get("relocation") or {}
    impact = record.get("implementation_impact") or {}
    worked_metrics = [metric(key, key.replace("_", " ").capitalize(), value.get("abs_delta"),
                             (record.get("scenario_kpis", {}).get(key) or {}).get("unit", "change"),
                             "Scenario value − baseline value", value)
                      for key, value in (record.get("deltas") or {}).items()]
    for row in worked_metrics:
        values = row["inputs"]
        before, after = values.get("baseline_value"), values.get("comparison_value")
        if number(before) and number(after):
            row["worked"] = f"{after} − {before} = {values.get('abs_delta')}. " + (
                f"Percentage change: {values.get('abs_delta')} / abs({before}) × 100 = {values.get('pct_delta')}%."
                if before else "Percentage change is undefined because the baseline is zero.")
    for side, report in reports.items():
        worked_metrics.extend({**row, "id": side + ":" + row["id"],
                               "label": side.capitalize() + " " + row["label"]} for row in report.get("metrics", []))
    if location:
        currency = (record.get("scenario_kpis", {}).get("business_network_cost") or {}).get("unit")
        worked_metrics.insert(0, metric("implementation_total", "One-time implementation cost", impact.get("one_time_cost"), currency,
            "Sum of all entered implementation categories; unknown if any category is blank", impact.get("items"), impact.get("basis", "")))
        worked_metrics.insert(1, metric("net_horizon_impact", "Net cost impact including implementation", impact.get("net_horizon_impact"), currency,
            "Scenario network cost − baseline network cost + one-time implementation cost", impact, impact.get("basis", "")))
        for side in ("baseline", "proposed"):
            proximity = location.get(side + "_proximity") or {}
            proximity_metric = metric("location:" + side, side.capitalize() + " demand proximity", proximity.get("weighted_distance_km"), "km",
                proximity.get("formula", "Sum(demand × great-circle km) / mapped demand"), proximity, proximity.get("scope", ""))
            if proximity.get("mapped_demand"):
                proximity_metric["worked"] = f"{proximity['sum_quantity_distance']} / {proximity['mapped_demand']} = {proximity['weighted_distance_km']} km"
            worked_metrics.append(proximity_metric)
        for lane in location.get("lanes", []):
            for field, label, unit in (("distance_km", "Lane distance", "km"), ("rate_per_unit", "Lane freight rate", currency), ("lead_time_days", "Lane transit time", "days")):
                formula = ("Uploaded lane distance × new great-circle distance / old great-circle distance" if field == "distance_km" else
                           lane["rate_formula"] if field == "rate_per_unit" else lane["time_formula"])
                row = metric(f"location:lane:{lane['lane_index']}:{field}", f"{label}: {lane['origin_id']} → {lane['destination_id']}", lane["after"][field], unit, formula, lane,
                             "Planning estimate captured before this solve; not a verified road route or replacement freight quote.")
                if field == "distance_km":
                    row["worked"] = f"{lane['before'][field]} × {lane['new_great_circle_km']} / {lane['old_great_circle_km']} = {lane['after'][field]} km"
                elif location.get("assumptions", {}).get("tariff_model") == "distance_proportional":
                    row["worked"] = f"{lane['before'][field]} × {lane['distance_ratio']} = {lane['after'][field]}"
                elif field == "rate_per_unit":
                    row["worked"] = f"{lane['before']['fixed_leg_cost']} + {lane['before']['rate_per_km']} × {lane['after']['distance_km']} = {lane['after'][field]}"
                else:
                    row["worked"] = f"{lane['before']['terminal_time_days']} + {lane['after']['distance_km']} / {lane['before']['speed_km_per_day']} = {lane['after'][field]}"
                worked_metrics.append(row)
    return {"schema_version": 1, "kind": "scenario", "title": "Scenario calculations",
            "project_id": record["project_id"], "snapshot_id": record["snapshot_id"],
            "execution_id": record.get("execution_id"), "computed_at": record.get("created_at"),
            "scope": {"scenario_id": record["id"], "name": record.get("name"), "request": record.get("request"),
                      "overrides": record.get("overrides")},
            "methodology": ["Compare this scenario with its captured baseline, over the same modeled horizon and currency.",
                            "Absolute change = scenario value − baseline value. Percentage change = absolute change / abs(baseline value) × 100. A zero baseline makes percentage change unavailable.",
                            "Savings versus the baseline can include re-optimization as well as the intervention. The unchanged re-optimized reference is retained in the source record to distinguish them.", *location.get("methodology", [])],
            "metrics": worked_metrics,
            "sources": {"request": record.get("request"), "overrides": record.get("overrides"),
                        "baseline": reports.get("baseline", {}).get("sources") or {"kpis": record.get("baseline_kpis")},
                        "scenario": reports.get("scenario", {}).get("sources") or {"kpis": record.get("scenario_kpis")},
                        "unchanged_reoptimized_reference": record.get("reference_kpis"),
                        "capacity_findings": record.get("capacity_response"), "provenance": record.get("provenance"),
                        "relocation": location, "implementation_impact": impact},
            "limitations": list(location.get("limitations", [])) + ([] if reports else ["This saved scenario predates detailed input and solver capture. Re-run it to generate the full calculation trail; the report does not pretend a new run is the old result."])}
