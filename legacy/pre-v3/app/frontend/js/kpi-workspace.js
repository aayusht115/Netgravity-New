/** Network/facility workspaces, per-tile briefings and durable monitoring controls. */
import { PLANTS, DCS, SOLVE_HORIZON, formatCurrency } from './data.js';
import { getWarehouseReport, renderWarehouseDashboard } from './warehouse.js';
import { getActiveProjectId, getActiveSnapshotId, onProjectChange } from './integration/project-context.js';
import { getCurrentUser } from './identity.js';
import { apiClient } from './integration/api-client.js';
import { renderKpiFacility, escapeKpi as esc } from './kpi-facility.js';

let view = 'network', selected = null, period = 'HORIZON', booted = false;
let insightRequest = 0, monitorRequest = 0;
const $ = id => document.getElementById(id);
const facilities = () => getActiveSnapshotId() ? [...DCS, ...PLANTS] : [];
const periodEntries = () => [...new Set([...Object.keys(SOLVE_HORIZON.periodLabels),
  ...Object.keys(SOLVE_HORIZON.byFacility?.[selected]?.throughput || {})])]
  .sort((a,b) => a.localeCompare(b, undefined, {numeric:true}))
  .map(key => [key, SOLVE_HORIZON.periodLabels[key] || `Model period ${key}`]);
const stamp = () => `${getCurrentUser()?.user_id || getCurrentUser()?.email || ''}:${getActiveProjectId()}:${getActiveSnapshotId()}`;
export const pinStorageKey = (user, project) => user && project ? `ng:kpi:pins:${JSON.stringify([user, project])}` : null;
function pinKey() { return pinStorageKey(getCurrentUser()?.user_id || getCurrentUser()?.email, getActiveProjectId()); }
function readPins() {
  try { const pins = JSON.parse(localStorage.getItem(pinKey()) || '[]'); return Array.isArray(pins) ? pins.filter(id => typeof id === 'string').slice(0, 12) : []; }
  catch { return []; }
}
function togglePin() {
  if (!selected || !pinKey()) return;
  const pins = readPins();
  if (!pins.includes(selected) && pins.length >= 12) { alert('You can pin up to 12 facilities. Remove a pin before adding another.'); return; }
  const next = pins.includes(selected) ? pins.filter(id => id !== selected) : [...pins, selected];
  try { localStorage.setItem(pinKey(), JSON.stringify(next)); } catch { alert('This browser cannot save pinned facilities. Enable local storage to keep pins.'); }
  refreshKpiWorkspace();
}

function selectFacility(id) {
  if (!facilities().some(f => f.id === id)) return;
  selected = id; view = 'facility';
  closeDialog('kpi-insight-dialog');
  refreshKpiWorkspace();
  $('kpi-facility-select')?.focus();
}

export function refreshKpiWorkspace() {
  if (!$('kpi-workspace-controls')) return;
  if (!booted) initKpiWorkspace();
  const all = facilities();
  if (!all.some(f => f.id === selected)) selected = all[0]?.id || null;
  if (period !== 'HORIZON' && !periodEntries().some(([key]) => key === period)) period = 'HORIZON';
  const report = getWarehouseReport(); const pins = readPins();
  $('kpi-workspace-controls').innerHTML = `<div class="kpi-view-tabs" role="tablist" aria-label="KPI dashboard scope">
    <button id="kpi-tab-network" role="tab" aria-selected="${view === 'network'}" aria-controls="kpi-network-panel" tabindex="${view === 'network' ? 0 : -1}" data-kpi-view="network"><strong>Network overview</strong><span>All facilities · full planning horizon</span></button>
    <button id="kpi-tab-facility" role="tab" aria-selected="${view === 'facility'}" aria-controls="kpi-facility-panel" tabindex="${view === 'facility' ? 0 : -1}" data-kpi-view="facility"><strong>Facility explorer</strong><span>Inspect a site · pin it · monitor KPIs</span></button></div>
    <div class="kpi-pins" aria-label="Pinned facilities"><strong>Pinned facilities</strong>${pins.length ? pins.map(id => {
      const f = all.find(item => item.id === id);
      return `<span class="kpi-pin-item"><button type="button" data-kpi-facility="${esc(id)}" ${f ? '' : 'disabled'} aria-pressed="${view === 'facility' && id === selected}">${esc(f?.name || id)}${f ? '' : ' · unavailable'}</button><button type="button" data-kpi-unpin="${esc(id)}" aria-label="Unpin ${esc(f?.name || id)}">Remove</button></span>`;
    }).join('') : '<span>Pin a facility from Facility explorer to keep it here.</span>'}<small>Saved for this account and project on this browser</small></div>`;
  $('kpi-network-panel').hidden = view !== 'network';
  $('kpi-facility-panel').hidden = view !== 'facility';
  $('kpi-facility-controls').innerHTML = `<div class="kpi-network-context"><strong>Network context</strong><span>${report ? `${report.n_open} open facilities · ${report.n_bottlenecks} at or above 90% · ${esc(formatCurrency(report.total_facility_spend))} facility costs over the full horizon` : 'Network report is not available yet.'}</span><button type="button" data-kpi-view="network">View all facilities</button></div>
    <div class="kpi-facility-picker"><label>Facility<select id="kpi-facility-select" aria-label="Inspect facility">${all.length ? all.map(f => `<option value="${esc(f.id)}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)} · ${esc(f.id)}</option>`).join('') : '<option>No facility loaded</option>'}</select></label>
    <label>Throughput period<select id="kpi-period-select" aria-label="Facility throughput period"><option value="HORIZON" ${period === 'HORIZON' ? 'selected' : ''}>Horizon average</option>${periodEntries().map(([key,label]) => `<option value="${esc(key)}" ${period === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
    <button type="button" class="btn btn-secondary" data-kpi-pin ${selected ? '' : 'disabled'} aria-pressed="${pins.includes(selected)}">${pins.includes(selected) ? 'Unpin facility' : 'Pin facility'}</button>
    <button type="button" class="btn btn-primary" data-kpi-monitor ${selected ? '' : 'disabled'}>Monitor KPIs</button></div>
    <p class="kpi-scope-note">Only Capacity & Throughput follows the period selector. Peak, cost, stock and corridor metrics cover the full solved horizon. No forecast or live telemetry is implied.</p>`;
  if (view === 'facility') renderKpiFacility(selected, period);
  decorateTiles();
  window.dispatchEvent(new Event('resize'));
}

const chartTiles = {
  'chart-wh-utilisation':'utilisation', 'chart-wh-spend':'spend', 'chart-wh-mix':'mix',
  'chart-wh-headroom':'headroom', 'chart-wh-stock':'stock', 'table-wh-health':'health',
  'chart-dash-throughput':'facility-throughput', 'chart-dash-costs':'facility-costs',
  'chart-dash-lanes':'facility-lanes', 'table-dash-lanes':'facility-telemetry',
};
function decorateTiles() {
  Object.entries(chartTiles).forEach(([id,key]) => { const card = $(id)?.closest('.card'); if (card) card.dataset.kpiTile = key; });
  const keys = ['network-facilities','network-tight','network-underused','network-peak'];
  document.querySelectorAll('#wh-summary-grid .dash-metric-card').forEach((card,i) => { card.dataset.kpiTile = keys[i]; });
  document.querySelectorAll('#tab-facility-dashboard [data-kpi-tile]').forEach(card => {
    if (card.querySelector(':scope > .kpi-insight-button')) return;
    const title = card.querySelector('.card-title,.dash-metric-title,.wh-attention-name')?.textContent?.trim() || 'Facility health';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'kpi-insight-button';
    button.setAttribute('aria-label', `AI insights: ${title}`); button.title = `Top optimisation insights for ${title}`;
    // Reuse the existing insight-detail.js sparkle asset, not a new icon style.
    button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/></svg>';
    button.append(document.createTextNode('Insights'));
    button.addEventListener('click', () => openInsights(card.dataset.kpiTile, title, card.dataset.kpiFacility));
    card.append(button);
  });
}

function closeDialog(id) { const dialog = $(id); if (dialog?.open) dialog.close(); }
function dialog(id, title) {
  let el = $(id);
  if (!el) { el = document.createElement('dialog'); el.id = id; el.className = 'kpi-dialog'; document.body.append(el); }
  el.setAttribute('aria-labelledby', `${id}-title`);
  el.innerHTML = `<div class="kpi-dialog-top"><h2 id="${id}-title">${esc(title)}</h2><button type="button" class="btn btn-secondary" data-kpi-close="${id}">Close</button></div><div class="kpi-dialog-body" aria-live="polite">Loading the current project’s evidence…</div>`;
  if (!el.open) el.showModal();
  return el;
}

async function openInsights(tile, title, facilityId) {
  const project = getActiveProjectId(); if (!project) return;
  const scope = stamp(), seq = ++insightRequest;
  const facility = facilityId || (tile.startsWith('facility-') ? selected : null);
  const el = dialog('kpi-insight-dialog', `Insights · ${title}`);
  const body = el.querySelector('.kpi-dialog-body');
  try {
    const result = await apiClient.post('/api/kpi-tile-insights', {project_id:project, tile,
      ...(facility ? {facility_id:facility} : {}), ...(tile === 'facility-utilisation' && period !== 'HORIZON' ? {period:SOLVE_HORIZON.periodLabels[period] || period} : {})}, {timeout:60000});
    if (scope !== stamp() || seq !== insightRequest || !el.open) return;
    const items = Array.isArray(result.insights) ? result.insights.slice(0,3) : [];
    const horizon = result.basis?.horizon;
    const basis = typeof result.basis === 'string' ? result.basis : `${horizon?.periods_modelled || SOLVE_HORIZON.periodsModelled} modelled periods · ${result.basis?.requested_period || 'full solved horizon'} · ${result.basis?.snapshot_id || 'snapshot not stated'}`;
    body.innerHTML = `<div class="kpi-insight-basis"><strong>${result.mode === 'ai' ? 'AI-assisted optimisation insights' : 'Evidence-based optimisation insights'}</strong><span>${esc(facility ? `${facilities().find(f => f.id === facility)?.name || facility} · ${facility}` : 'All facilities')}</span><span>${esc(basis)}</span><small>Data version: ${esc(result.data_version || 'Not reported')}</small></div>
      ${items.length ? `<ol class="kpi-insight-list">${items.map(item => `<li><h3>${esc(item.title)}</h3><p>${esc(item.evidence)}</p><div><strong>Optimisation action</strong><p>${esc(item.action)}</p></div>${item.facility_id && facilities().some(f => f.id === item.facility_id) ? `<button type="button" class="kpi-text-button" data-kpi-facility="${esc(item.facility_id)}">Inspect ${esc(item.facility_id)}</button>` : ''}</li>`).join('')}</ol>` : '<p>No supported findings are available for this tile yet.</p>'}
      <p class="kpi-scope-note">${esc(result.disclosure || 'Findings are grounded in the solved model. Validate proposed changes in a scenario before acting; no saving is assumed.')}</p>
      <button type="button" class="btn btn-secondary" data-kpi-scenarios>Test a network scenario</button>`;
  } catch (error) {
    if (scope !== stamp() || seq !== insightRequest || !el.open) return;
    body.textContent = `Insights unavailable: ${error.message || 'The evidence service could not be reached.'} Close and retry. No findings have been invented.`;
  }
}

const directionLabel = {increase:'Increases by at least', decrease:'Decreases by at least', above:'Crosses above', below:'Crosses below'};
const formatDate = value => value ? new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString() : 'Not checked yet';
async function openMonitor() {
  const project = getActiveProjectId(), facilityId = selected, scope = stamp(), seq = ++monitorRequest;
  if (!project || !facilityId) return;
  const el = dialog('kpi-monitor-dialog', 'Monitor facility KPIs');
  const body = el.querySelector('.kpi-dialog-body');
  try {
    const result = await apiClient.get('/api/kpi-monitors', {project_id:project});
    if (scope !== stamp() || seq !== monitorRequest || !el.open) return;
    const capabilities = result.capabilities || {}, delivery = capabilities.email_delivery || {};
    let existing = result.monitors?.find(m => m.facility_id === facilityId);
    const metrics = capabilities.metrics || []; const ready = delivery.configured && capabilities.worker_enabled;
    body.innerHTML = `<p><strong>${esc(facilities().find(f => f.id === facilityId)?.name || facilityId)}</strong> · ${esc(facilityId)}</p>
      <div class="kpi-monitor-delivery ${ready ? '' : 'is-unavailable'}"><strong>${ready ? 'Email delivery is configured' : 'Email alerts are not ready'}</strong><p>${ready ? 'Enable the monitor below to receive alerts when a rule matches.' : 'You can save rules paused. Email setup and a running background worker are required before enabling alerts.'}</p><p>Recipient: ${esc(getCurrentUser()?.email || existing?.recipient || 'Your signed-in account')}</p></div>
      <p class="kpi-scope-note">Checks new analysed uploads, not a live telemetry stream. The first comparable version sets the baseline without emailing.</p>
      <details class="kpi-monitor-details"><summary>Delivery setup &amp; evaluation details</summary><p>${esc(delivery.reason || 'Email channel available.')}${capabilities.worker_enabled ? '' : ' The background monitoring worker is not enabled in this environment.'}</p><p>${esc(capabilities.evaluation_basis || '')}</p><p>Data version: ${esc(existing?.state?.last_version || 'Awaiting a baseline')} · Latest email: ${esc(existing?.state?.last_alert?.status || 'No alert yet')}</p></details>
      ${existing ? `<div class="kpi-monitor-status"><strong>Current state: ${esc(existing.state?.status || 'paused')}</strong><span>Last checked: ${esc(formatDate(existing.state?.last_checked_at))}</span></div>` : ''}
      <form id="kpi-monitor-form"><fieldset><legend>Choose KPIs and exact alert rules</legend>${metrics.map((metric,i) => {
        const rule = existing?.rules?.find(r => r.metric === metric.key);
        return `<div class="kpi-rule-row"><label><input type="checkbox" name="metric" value="${esc(metric.key)}" ${rule ? 'checked' : ''}>${esc(metric.label)}</label>
        <label class="kpi-rule-direction"><span class="sr-only">Direction for ${esc(metric.label)}</span><select name="direction-${i}">${(capabilities.directions || []).map(d => `<option value="${esc(d)}" ${rule?.direction === d ? 'selected' : ''}>${esc(directionLabel[d] || d)}</option>`).join('')}</select></label>
        <label><span class="sr-only">Threshold for ${esc(metric.label)}</span><input type="number" min="0" step="any" name="threshold-${i}" value="${rule?.threshold ?? ''}" placeholder="Threshold"><small>${esc(metric.change_unit)} for changes; ${esc(metric.unit)} for crossings</small></label></div>`;
      }).join('')}</fieldset>
      <label class="kpi-instructions">Instructions / business context<textarea name="instructions" maxlength="2000" rows="3" placeholder="For example: Flag capacity pressure before moving demand into Atlanta. Compare only the same planning horizon.">${esc(existing?.instructions || '')}</textarea><small>Context is included in the alert. Only the explicit KPI rules above trigger email; free text is not executed.</small></label>
      <label class="kpi-enable"><input type="checkbox" name="enabled" ${existing?.enabled && ready ? 'checked' : ''} ${ready ? '' : 'disabled'}> Enable background email monitoring</label>
      <p class="kpi-scope-note">The first comparable version sets the baseline without emailing. Any matching rule can alert. Editing rules starts a new comparison baseline.</p>
      <div role="status" id="kpi-monitor-feedback"></div><button type="submit" class="btn btn-primary">${existing ? 'Save monitor changes' : 'Save monitor'}</button></form>`;
    const form = $('kpi-monitor-form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (scope !== stamp()) return;
      const feedback = $('kpi-monitor-feedback'); const submit = form.querySelector('[type="submit"]');
      const rules = metrics.flatMap((metric,i) => {
        const checked = [...form.querySelectorAll('input[name="metric"]')].find(input => input.value === metric.key)?.checked;
        if (!checked) return [];
        const raw = form.elements[`threshold-${i}`].value;
        return [{metric:metric.key, direction:form.elements[`direction-${i}`].value, threshold:raw === '' ? null : Number(raw)}];
      });
      if (!rules.length || rules.some(r => r.threshold === null || !Number.isFinite(r.threshold) || r.threshold < 0 || (['increase','decrease'].includes(r.direction) && r.threshold === 0))) {
        feedback.textContent = 'Select at least one KPI and enter a valid threshold. Change thresholds must be greater than zero.'; return;
      }
      submit.disabled = true; feedback.textContent = 'Saving…';
      const payload = {project_id:project,rules,instructions:form.elements.instructions.value,enabled:ready && form.elements.enabled.checked};
      try {
        const saved = existing
          ? await apiClient.request(`/api/kpi-monitors/${encodeURIComponent(existing.id)}`, {method:'PATCH', body:JSON.stringify(payload)})
          : await apiClient.post('/api/kpi-monitors', {...payload,facility_id:facilityId});
        if (scope !== stamp() || !el.open) return;
        feedback.textContent = payload.enabled ? 'Monitor saved and enabled. The first comparable version establishes its baseline; no email was sent by saving.' : 'Monitor saved paused. It will not send email until you enable it.';
        existing = saved.monitor; submit.disabled = false; submit.textContent = 'Save monitor changes';
      } catch (error) { if (scope === stamp() && el.open) { feedback.textContent = error.message || 'Could not save monitor.'; submit.disabled = false; } }
    });
  } catch (error) { if (scope === stamp() && seq === monitorRequest && el.open) body.textContent = `Monitoring unavailable: ${error.message || 'Please retry.'}`; }
}

export function initKpiWorkspace() {
  if (booted) return; booted = true;
  document.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.kpiClose) closeDialog(target.dataset.kpiClose);
    if (target.dataset.kpiView) { view = target.dataset.kpiView; refreshKpiWorkspace(); if (view === 'network') renderWarehouseDashboard(); }
    if (target.dataset.kpiFacility) selectFacility(target.dataset.kpiFacility);
    if (target.hasAttribute('data-kpi-pin')) togglePin();
    if (target.dataset.kpiUnpin && pinKey()) {
      try { localStorage.setItem(pinKey(), JSON.stringify(readPins().filter(id => id !== target.dataset.kpiUnpin))); } catch { /* Storage may be disabled. */ }
      refreshKpiWorkspace();
    }
    if (target.hasAttribute('data-kpi-monitor')) openMonitor();
    if (target.hasAttribute('data-kpi-scenarios')) { closeDialog('kpi-insight-dialog'); window.navigateToTab?.('scenarios'); }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'kpi-facility-select') selectFacility(event.target.value);
    if (event.target.id === 'kpi-period-select') { period = event.target.value; refreshKpiWorkspace(); $('kpi-period-select')?.focus(); }
  });
  document.addEventListener('keydown', event => {
    if (!event.target.matches('.kpi-view-tabs [role="tab"]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); view = event.key === 'Home' ? 'network' : event.key === 'End' ? 'facility' : view === 'network' ? 'facility' : 'network';
    refreshKpiWorkspace(); $(`kpi-tab-${view}`)?.focus();
  });
  window.addEventListener('warehouseReportUpdated', () => {
    // An open briefing never silently retains a previous solved snapshot.
    insightRequest++; closeDialog('kpi-insight-dialog');
    refreshKpiWorkspace();
  });
  onProjectChange(() => {
    selected = null; period = 'HORIZON'; view = 'network'; insightRequest++; monitorRequest++;
    closeDialog('kpi-insight-dialog'); closeDialog('kpi-monitor-dialog'); refreshKpiWorkspace();
  });
  window.addEventListener('identityChanged', () => {
    insightRequest++; monitorRequest++; closeDialog('kpi-insight-dialog'); closeDialog('kpi-monitor-dialog');
    refreshKpiWorkspace();
  });
  const panel = $('tab-facility-dashboard');
  if (panel) new MutationObserver(decorateTiles).observe(panel, {childList:true,subtree:true});
}
