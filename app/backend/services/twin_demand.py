"""Read-only demand projection for the preserved Atlas map, independent of scenarios."""
from __future__ import annotations

import math


def demand_surface(network):
    """Aggregate the bound network's input rows; never forecast or run a solve."""
    totals = {}
    for row in network.demands:
        totals[row.market_id] = totals.get(row.market_id, 0.0) + row.quantity
    facilities = {facility.id: facility for facility in network.facilities}
    points, omitted = [], []
    for market_id, quantity in totals.items():
        facility = facilities.get(market_id)
        item = {"id": market_id, "name": facility.name if facility else market_id,
                "quantity": quantity}
        lat, lon = (facility.latitude, facility.longitude) if facility else (None, None)
        valid = all(isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) for value in (lat, lon))
        if valid and abs(lat) <= 85.0511287798066 and abs(lon) <= 180:
            points.append({**item, "latitude": lat, "longitude": lon})
        else:
            omitted.append(item)
    total = sum(totals.values())
    mapped = sum(point["quantity"] for point in points)
    return {
        "points": points, "omitted": omitted, "total_quantity": total,
        "mapped_quantity": mapped, "coverage_pct": 100 * mapped / total if total else None,
        "periods": sorted({row.period for row in network.demands}, key=str),
        "period_labels": dict(getattr(network, "period_labels", {}) or {}),
        "methodology": (
            "Sum the bound network's demand quantities across products and planning periods "
            "by market/customer ID. Use each matching facility's uploaded coordinates. "
            "Mapped coverage = demand with valid Web Mercator coordinates / total demand. "
            "Colour represents relative demand quantity, not customer count, forecast, "
            "road routing, or service risk. Missing coordinates are listed, not invented."
        ),
    }
