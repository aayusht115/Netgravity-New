import { apiClient } from './integration/api-client.js';
import { getActiveProjectId, getActiveSnapshotId, onProjectChange } from './integration/project-context.js';

export const escapeCalculationText = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const esc = escapeCalculationText;
let generation = 0;
let nodes = [];

function valueText(value) {
  if (value === null || value === undefined) return 'Not available';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function sourceNode(label, value) {
  if (value && typeof value === 'object') {
    const id = nodes.push(value) - 1;
    return `<details class="calc-source" data-calc-node="${id}"><summary>${esc(label)} <span>${Object.keys(value).length} records</span></summary><div></div></details>`;
  }
  return `<div class="calc-value"><span>${esc(label)}</span><strong>${esc(valueText(value))}</strong></div>`;
}

function mountDialog() {
  let dialog = document.getElementById('calculation-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'calculation-dialog';
  dialog.setAttribute('aria-labelledby', 'calculation-title');
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => { generation++; nodes = []; });
  dialog.addEventListener('click', event => { if (event.target.closest('[data-close-calculations]')) dialog.close(); });
  dialog.addEventListener('toggle', event => {
    const details = event.target;
    if (!details.open || !details.matches('[data-calc-node]') || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    const data = nodes[Number(details.dataset.calcNode)];
    const entries = Object.entries(data || {});
    const body = details.querySelector(':scope > div');
    let page = 0;
    const append = () => {
      body.querySelector('[data-more-records]')?.remove();
      const batch = entries.slice(page * 100, ++page * 100);
      body.insertAdjacentHTML('beforeend', batch.map(([key, val]) => sourceNode(Array.isArray(data) ? `Record ${Number(key)+1}` : key.replaceAll('_',' '), val)).join(''));
      if (page * 100 < entries.length) {
        const more = document.createElement('button');
        more.type = 'button'; more.dataset.moreRecords = '1';
        more.textContent = `Show next records (${entries.length - page * 100} remaining)`;
        more.addEventListener('click', append); body.appendChild(more);
      }
    };
    append();
  }, true);
  for (const name of ['projectChanged', 'identityChanged', 'snapshotChanged', 'projectSnapshotChanged']) {
    window.addEventListener(name, () => { generation++; if (dialog.open) dialog.close(); });
  }
  onProjectChange(() => { generation++; if (dialog.open) dialog.close(); });
  return dialog;
}

export async function openCalculations(path, params = {}, metricId = null) {
  const dialog = mountDialog();
  const requestId = ++generation;
  const project = getActiveProjectId(), snapshot = getActiveSnapshotId();
  const query = { ...params, project_id: project, snapshot_id: snapshot };
  dialog.innerHTML = '<div class="calc-toolbar"><h2 id="calculation-title">Calculation details</h2><button type="button" data-close-calculations aria-label="Close calculations">Close</button></div><p role="status">Loading the calculation record for this run…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const report = await apiClient.get(path, query, {timeout: 60000});
    if (requestId !== generation || project !== getActiveProjectId() || snapshot !== getActiveSnapshotId()) return;
    nodes = [];
    const href = `${path}?${new URLSearchParams({...query, format:'docx'})}`;
    dialog.innerHTML = `<div class="calc-toolbar"><h2 id="calculation-title">${esc(report.title)}</h2><div><a class="calc-download" href="${esc(href)}">Download Word</a><button type="button" data-close-calculations aria-label="Close calculations">Close</button></div></div>
      <section><h3>1. Result and scope</h3><p>This record belongs to the selected run. AI explains results; Python calculates them.</p>${sourceNode('Run identity', {project_id:report.project_id,snapshot_id:report.snapshot_id,execution_id:report.execution_id,computed_at:report.computed_at})}${sourceNode('Selected scope', report.scope)}</section>
      <section><h3>2. Methodology and assumptions</h3>${(report.methodology || []).map(line=>`<p>${esc(line)}</p>`).join('')}${(report.limitations || []).map(line=>`<p class="calc-warning">${esc(line)}</p>`).join('')}</section>
      <section><h3>3. Worked calculations</h3>${(report.metrics || []).map(row=>`<details class="calc-metric" data-metric-id="${esc(row.id)}" ${metricId === row.id ? 'open' : ''}><summary><span>${esc(row.label)}</span><strong>${esc(valueText(row.value))} ${esc(row.unit || '')}</strong></summary><p class="calc-formula">${esc(row.formula)}</p>${row.worked?`<p class="calc-worked">${esc(row.worked)}</p>`:''}${row.note?`<p>${esc(row.note)}</p>`:''}${sourceNode('Actual calculation inputs',row.inputs)}</details>`).join('')}</section>
      <section><h3>4. Source data and calculation records</h3><p>Expand each record to inspect the original inputs and engine outputs. No example values are substituted.</p>${Object.entries(report.sources || {}).map(([key,val])=>sourceNode(key.replaceAll('_',' '),val)).join('')}</section>`;
    if (metricId) dialog.querySelector(`[data-metric-id="${CSS.escape(metricId)}"]`)?.scrollIntoView({block:'center'});
  } catch (error) {
    if (requestId !== generation) return;
    dialog.querySelector('[role="status"]').textContent = error?.message || 'The calculation record could not be loaded. Close and retry.';
  }
}

export function openForecastCalculations(metricId = null) {
  const meta = window.__ngForecastMeta;
  if (!meta?.executionId || !meta?.shown) return;
  const select = document.getElementById('fc-series-select');
  return openCalculations(`/api/forecast/calculations/${encodeURIComponent(meta.executionId)}`,
    {series_id:select?.value || meta.shown}, metricId);
}
