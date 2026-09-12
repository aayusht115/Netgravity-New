import { FORECAST, FORECAST_CATALOGUE } from './data.js';
import { forecastMetrics, forecastNumber, forecastPeriodUnit } from './forecast-metrics.js';
import { reloadDemandForecast } from './integration/hydrate.js';
import { getActiveProjectId, getActiveSnapshotId } from './integration/project-context.js';
import { openForecastCalculations } from './calculations.js';

const text = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const number = value => forecastNumber(value) === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function renderForecastWorkspace() {
  const grid = document.getElementById('fc-kpi-grid');
  if (!grid) return;
  const entry = FORECAST_CATALOGUE.find(row => row.key === FORECAST.seriesLabel);
  const metrics = forecastMetrics(entry);
  const meta = window.__ngForecastMeta;
  const busy = !!window.__ngForecastLoad?.loading;
  const unit = forecastPeriodUnit(entry?.frequency);
  const count = `${metrics.horizon} ${unit}${metrics.horizon === 1 ? '' : 's'}`;
  document.getElementById('fc-kpi-scope').textContent = entry
    ? `${entry.label} · ${entry.key} · next ${count}`
    : meta?.reason || 'No forecast is available. Upload observed demand history to model demand.';
  const growthNote = metrics.recent === null ? `Needs ${metrics.horizon || 'matching'} complete observed periods`
    : metrics.recent === 0 ? 'Recent demand is zero; a percentage change is undefined'
    : `Compared with the last ${count} (${number(metrics.recent)} units); equal-length windows`;
  const rows = [
    ['Forecast demand', number(metrics.total), metrics.total === null ? 'Not available' : `units · total over the next ${count}`],
    ['Change vs recent history', metrics.growth === null ? '—' : `${metrics.growth > 0 ? '+' : ''}${number(metrics.growth)}%`, growthNote],
    ['Peak forecast demand', number(metrics.peak), metrics.peak === null ? 'Not available' : `units · ${unit} ${metrics.peakLabel} · busiest mean-demand period`],
    ['Range in peak period', metrics.peakLower === null ? '—' : `${number(metrics.peakLower)}–${number(metrics.peakUpper)}`,
      metrics.peakLower === null ? 'No forecast range reported' : `units · p10–p90 for ${unit} ${metrics.peakLabel}; not a guaranteed capacity limit`],
  ];
  const calculationIds = ['forecast_total', 'forecast_growth', 'forecast_peak', 'forecast_range'];
  grid.innerHTML = rows.map(([label, value, note], index) => `<article class="fc-kpi-tile"><h3>${text(label)} <button type="button" class="kpi-calc-info" data-forecast-calculation="${calculationIds[index]}" aria-label="How ${text(label)} is calculated" ${entry ? '' : 'disabled'}>i</button></h3><strong>${text(value)}</strong><p>${text(note)}</p></article>`).join('');
  grid.querySelectorAll('[data-forecast-calculation]').forEach(button => button.addEventListener('click', () => openForecastCalculations(button.dataset.forecastCalculation)));
  const quality = !metrics.folds ? 'Not backtested'
    : metrics.mase === null ? 'Benchmark unavailable'
    : metrics.mase < 1 ? 'Beats the naive benchmark' : metrics.mase === 1 ? 'Matches the naive benchmark' : 'Below the naive benchmark';
  const validation = document.getElementById('fc-validation-card');
  const warnings = [...new Set([...(entry?.warnings || []), ...(meta?.warnings || [])])];
  validation.innerHTML = `<h3>Model & validation</h3>
    <dl><div><dt>Selected model</dt><dd>${text(entry?.engine || 'Not available')}</dd></div>
    <div><dt>Demand pattern</dt><dd>${text(entry?.pattern?.toLowerCase().replaceAll('_', ' ') || 'Not reported')}</dd></div>
    <div><dt>History supplied / fitted</dt><dd>${entry ? `${metrics.historyPeriods} / ${number(entry.regime?.n_periods_used ?? metrics.historyPeriods)} periods` : '—'}</dd></div>
    <div><dt>Backtest error (WAPE)</dt><dd>${metrics.folds && metrics.wape !== null ? `${number(metrics.wape * 100)}%` : 'Not measured'}</dd></div>
    <div><dt>MASE · ${metrics.folds || 0} folds</dt><dd>${metrics.folds && metrics.mase !== null ? metrics.mase.toFixed(2) : 'Not measured'}</dd></div></dl>
    <p class="fc-quality-note">${text(entry ? quality : 'Upload demand history to evaluate a model.')}.
      ${metrics.folds && metrics.wape !== null && metrics.wape >= 1 ? '<strong>Absolute backtest error is at least 100% of observed demand. Review this model before planning.</strong>' : ''}</p>
    <details><summary>How to use this model</summary>
      <p>Models are selected automatically from demand patterns and usable history. Structural-break checks may use a more recent history window.</p>
      <p>Backtests measure historical error; lower is better. MASE below 1 beats repeating the last observation. These are not accuracy guarantees for this forecast horizon.</p>
      <p>${entry?.signalAdjustments?.length ? `${entry.signalAdjustments.length} signal adjustment(s) applied. Their effects are declared assumptions, not learned causal effects.` : 'No signal adjustment is reported for this series.'}</p>
      <p>The p10–p90 band describes individual future periods. Adding its bounds does not give a valid whole-horizon interval.</p>
      ${entry?.regime?.reason ? `<p>${text(entry.regime.reason)}</p>` : ''}
      ${warnings.length ? `<h4>Model cautions</h4><ul>${warnings.map(w => `<li>${text(w)}</li>`).join('')}</ul>` : ''}
    </details><button type="button" class="calc-button" id="forecast-see-calculations" ${entry ? '' : 'disabled'}>See calculations / Download Word</button>`;
  document.getElementById('forecast-see-calculations')?.addEventListener('click', () => openForecastCalculations());
  const run = document.getElementById('fc-run-model');
  const horizon = document.getElementById('fc-horizon-select');
  if (!meta && !busy) { horizon.dataset.edited = ''; horizon.value = '6'; }
  const status = document.getElementById('fc-model-status');
  run.disabled = busy || !getActiveProjectId() || !getActiveSnapshotId();
  run.textContent = busy ? 'Modelling…' : 'Run forecast';
  horizon.disabled = busy;
  [...horizon.options].forEach(option => { option.textContent = `${option.value} ${unit}s`; });
  if (meta?.horizon && !busy && horizon.dataset.edited !== '1') horizon.value = String(meta.horizon);
  const pending = !busy && entry && Number(horizon.value) !== meta?.horizon;
  status.textContent = busy ? `Modelling the next ${window.__ngForecastLoad.horizon} periods. Existing results remain visible until the run completes.`
    : pending ? 'Horizon changed. Click Run forecast to update the chart and KPIs.'
    : !getActiveSnapshotId() ? 'Open a project with uploaded network and demand history to run a forecast.'
    : !entry ? meta?.reason || 'No forecastable series. Upload observed demand history, then run the forecast.'
    : `Showing ${count} · ${meta.series}/${meta.requestedSeries ?? meta.series} forecastable series · no network changes applied.`
      + (warnings.some(w => /recursive/i.test(w)) ? ' Caution: longer-horizon ranges may understate uncertainty. See model details.' : '');
  grid.setAttribute('aria-busy', String(busy));
  const form = document.getElementById('fc-model-form');
  if (!form.dataset.wired) {
    form.dataset.wired = '1';
    horizon.addEventListener('change', () => { horizon.dataset.edited = '1'; renderForecastWorkspace(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (run.disabled) return;
      const value = Number(horizon.value);
      if (![3, 6, 12].includes(value)) return;
      horizon.dataset.edited = '';
      await reloadDemandForecast(value);
    });
  }
}

if (typeof window !== 'undefined') window.addEventListener('forecastLoadChanged', renderForecastWorkspace);
