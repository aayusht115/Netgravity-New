/** Pure, scope-explicit KPI presentation calculations. Missing is never zero. */
export const finiteMetric = value => typeof value === 'number' && Number.isFinite(value);

export function facilityPeriodMetrics(facility, horizon, periodKey, health) {
  const series = horizon?.byFacility?.[facility?.id];
  const selected = periodKey != null && periodKey !== '' && periodKey !== 'HORIZON';
  const key = selected ? String(periodKey) : null;
  const raw = key === null ? health?.avg_throughput_units : series?.throughput?.[key];
  const capacity = finiteMetric(health?.rated_capacity_per_period)
    ? health.rated_capacity_per_period : facility?.capacity;
  const throughput = finiteMetric(raw) ? raw : null;
  const reportedUtil = key === null ? health?.avg_utilization_pct : series?.utilisation?.[key];
  const utilisation = health?.is_open === false ? null : finiteMetric(reportedUtil) ? reportedUtil
    : finiteMetric(throughput) && finiteMetric(capacity) && capacity > 0 ? throughput / capacity * 100 : null;
  const peak = health?.peak_throughput_units;
  return { throughput, capacity: finiteMetric(capacity) ? capacity : null, utilisation,
    peakHeadroom: health?.is_open !== false && finiteMetric(capacity) && finiteMetric(peak) ? capacity - peak : null,
    basis: selected ? (horizon?.periodLabels?.[key] || `Model period ${key}`) : 'Horizon average' };
}

export function corridorMetrics(lanes) {
  const unknownFlowCount = lanes.filter(lane => !finiteMetric(lane.flowHorizon)).length;
  const active = lanes.filter(lane => finiteMetric(lane.flowHorizon) && lane.flowHorizon > 0);
  const totalFlow = active.reduce((sum, lane) => sum + lane.flowHorizon, 0);
  const weighted = field => !unknownFlowCount && active.length && active.every(lane => finiteMetric(lane[field]))
    ? active.reduce((sum, lane) => sum + lane.flowHorizon * lane[field], 0) / totalFlow : null;
  const carbonComplete = !unknownFlowCount && active.length > 0 && active.every(lane => finiteMetric(lane.carbonKg));
  const carbon = carbonComplete ? active.reduce((sum, lane) => sum + lane.carbonKg, 0) : null;
  return { activeCount: active.length, connectedCount: lanes.length,
    unknownFlowCount,
    totalFlow: unknownFlowCount ? null : totalFlow,
    weightedCost: weighted('cost'), weightedLead: weighted('leadTime'), carbon,
    carbonPerUnit: carbonComplete && totalFlow > 0 ? carbon / totalFlow : null };
}
