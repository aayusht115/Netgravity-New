import { PLANTS, DCS, LANES, SOLVE_HORIZON, getFacilityById,
  isDCFacility, formatCurrency, formatCurrencyExact, formatNumber, fmtNum } from './data.js';
import { getWarehouseReport } from './warehouse.js';
import { renderFacilityThroughputChart, renderFacilityCostBreakdownChart,
  renderFacilityLaneFlowsChart, clearDashboardChart } from './charts.js';
import { finiteMetric as valid, facilityPeriodMetrics, corridorMetrics } from './kpi-metrics.js';

export const escapeKpi = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => valid(value) ? formatNumber(value) : '—';
const percent = value => valid(value) ? `${fmtNum(value,1)}%` : 'Not reported';
const text = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

export function renderKpiFacility(facilityId, periodKey) {
  const fac = [...DCS, ...PLANTS].find(f => f.id === facilityId);
  const grid = document.getElementById('dash-metrics-grid');
  if (!fac) {
    if (grid) grid.innerHTML = '<div class="card"><h3>No facility selected</h3><p>Select a loaded facility to inspect its metrics.</p></div>';
    text('dash-facility-name', 'No facility selected'); text('dash-facility-type', '');
    ['chart-dash-throughput','chart-dash-costs','chart-dash-lanes'].forEach(id => clearDashboardChart(id, 'No facility selected.'));
    text('dash-corridor-summary', 'No facility selected.');
    ['dash-util-tag','dash-total-cost-tag','dash-lane-count-tag'].forEach(id => text(id, '—'));
    const body = document.querySelector('#table-dash-lanes tbody');
    if (body) body.innerHTML = '<tr><td colspan="7">No facility selected.</td></tr>';
    return null;
  }
  const report = getWarehouseReport();
  const health = report?.health_kpis?.find(row => row.facility_id === fac.id);
  const metric = facilityPeriodMetrics(fac, SOLVE_HORIZON, periodKey, health);
  const lanes = LANES.filter(lane => lane.from === fac.id || lane.to === fac.id).map(lane => {
    const outbound = lane.from === fac.id;
    const peerId = outbound ? lane.to : lane.from;
    const peerName = getFacilityById(peerId)?.name || peerId;
    return {...lane, peerId, peerName, direction: outbound ? 'Outbound' : 'Inbound',
      label: `${outbound ? '→' : '←'} ${peerName}`};
  });
  const corridor = corridorMetrics(lanes);
  const reported = corridorMetrics(lanes.filter(lane => valid(lane.flowHorizon)));
  const corridorBasis = `${lanes.length - corridor.unknownFlowCount} / ${lanes.length} corridors report flow · full horizon`;
  const span = `${SOLVE_HORIZON.periodsModelled} modelled period${SOLVE_HORIZON.periodsModelled === 1 ? '' : 's'}`;
  text('dash-facility-name', fac.name || fac.id);
  text('dash-facility-type', `${fac.id} · ${isDCFacility(fac.id) ? 'Distribution Centre' : 'Plant'}`);
  const dot = document.getElementById('dash-facility-dot');
  if (dot) dot.style.background = !health ? 'var(--text-3)' : health.health_band === 'CRITICAL' ? 'var(--red)'
    : health.health_band === 'TIGHT' ? 'var(--amber)' : health.health_band === 'UNDERUSED' ? 'var(--blue)'
    : health.is_open ? 'var(--green)' : 'var(--text-3)';
  const cost = valid(health?.total_facility_cost) ? formatCurrency(health.total_facility_cost) : 'Not reported';
  const inventory = valid(health?.avg_inventory_units) ? `${number(health.avg_inventory_units)} units` : 'Not modelled';
  const cards = [
    ['facility-utilisation', 'Capacity & Throughput', health?.is_open === false ? 'Not operating' : percent(metric.utilisation),
      `${metric.basis} · ${number(metric.throughput)} / ${number(metric.capacity)} units`,
      health?.is_open === false ? 'Not open in this plan' : `Horizon peak: ${percent(health?.peak_utilization_pct)}`],
    ['facility-headroom', 'Headroom at Peak', health?.is_open === false ? 'Not operating' : valid(metric.peakHeadroom) ? `${number(metric.peakHeadroom)} units` : 'Not reported',
      `Rated capacity minus busiest-period throughput · ${span}`,
      health ? `${health.bottleneck_periods_count ?? '—'} / ${health.periods_observed ?? '—'} periods at or above 90%` : 'Waiting for the facility health report'],
    ['facility-cost', 'Attributed Facility Cost', cost, `Full horizon · ${span} · transport excluded`,
      valid(health?.fixed_cost) ? `Fixed cost: ${formatCurrency(health.fixed_cost)}` : 'No attributed cost available'],
    ['facility-stock', 'Average Stock Held', inventory, `Full horizon · ${span}`,
      valid(health?.peak_inventory_units) ? `Peak stock: ${number(health.peak_inventory_units)} units` : 'No inventory decisions reported; this is not zero stock'],
    ['facility-lead', 'Flow-weighted Transit Time', valid(reported.weightedLead) ? `${reported.weightedLead.toFixed(1)} days` : 'Not reported',
      corridorBasis, 'Reported-flow arcs only; not an end-to-end delivery promise'],
    ['facility-carbon', 'Connected Corridor Carbon', valid(reported.carbonPerUnit) ? `${reported.carbonPerUnit.toFixed(4)} kg CO₂e/unit` : 'Not reported',
      `Reported-flow subtotal: ${number(reported.carbon)} kg · ${corridorBasis}`, 'Per arc-flow unit, inbound + outbound; not whole-facility footprint'],
  ];
  if (grid) grid.innerHTML = cards.map(([key,title,value,basis,note]) => `<div class="dash-metric-card" data-kpi-tile="${key}">
    <div class="dash-metric-title">${escapeKpi(title)}</div><div class="dash-metric-val">${escapeKpi(value)}</div>
    <div class="dash-metric-sub">${escapeKpi(basis)}</div><div class="dash-metric-sub">${escapeKpi(note)}</div></div>`).join('');
  text('dash-util-tag', `${span} · solved plan`);
  text('dash-total-cost-tag', `${cost} · full horizon`);
  text('dash-lane-count-tag', `${corridor.activeCount} active / ${lanes.length} connected`);
  renderFacilityThroughputChart('chart-dash-throughput', fac);
  renderFacilityCostBreakdownChart('chart-dash-costs', fac, health);
  renderFacilityLaneFlowsChart('chart-dash-lanes', lanes, fac.id);
  const summary = document.getElementById('dash-corridor-summary');
  if (summary) summary.innerHTML = `<strong>Connected corridor evidence</strong>
    <p>${corridor.activeCount} reported positive-flow arcs carry a subtotal of ${number(reported.totalFlow)} units over the full horizon. Inbound and outbound flows count separate arc movements.</p>
    <p>Flow-weighted transport rate for reported-flow arcs: ${valid(reported.weightedCost) ? escapeKpi(formatCurrencyExact(reported.weightedCost)) + ' / unit' : 'not reported'}.</p>
    <p>${corridor.unknownFlowCount ? `${corridor.unknownFlowCount} connected arcs have no reported flow.` : 'Zero-flow arcs are shown in the table but excluded from active counts and weighted rates.'}</p>`;
  text('th-corridor-flow', 'Flow · full horizon');
  const body = document.querySelector('#table-dash-lanes tbody');
  if (body) body.innerHTML = lanes.length ? lanes.map(l => `<tr><td><strong>${escapeKpi(l.peerName)}</strong><small class="kpi-id">${escapeKpi(l.from)} → ${escapeKpi(l.to)}</small></td>
    <td>${escapeKpi(l.direction)}</td><td class="num">${number(l.flowHorizon)} units${l.flowHorizon === 0 ? '<small class="kpi-id">Inactive</small>' : ''}</td>
    <td class="num">${number(l.distance)} km</td><td class="num">${valid(l.cost) ? escapeKpi(formatCurrencyExact(l.cost)) : '—'}</td>
    <td class="num">${number(l.leadTime)} days</td><td>${escapeKpi(l.mode || 'Not stated')}</td></tr>`).join('')
    : '<tr><td colspan="7">No connected corridors in this network.</td></tr>';
  return {fac, health, metric, corridor};
}
