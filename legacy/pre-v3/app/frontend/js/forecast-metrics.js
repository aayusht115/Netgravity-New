/** Display calculations over one engine-produced market/product series.
 * No fitting, inferred capacity or invented accuracy belongs in this layer.
 */
export const forecastNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function completeTotal(values) {
  return values.length && values.every(v => forecastNumber(v) !== null && v >= 0)
    ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function forecastMetrics(entry) {
  const values = entry?.forecast?.values || [];
  const labels = entry?.forecast?.labels || [];
  const history = entry?.history?.values || [];
  const total = completeTotal(values);
  const horizon = labels.length;
  const valid = horizon > 0 && values.length === horizon && total !== null;
  const recent = valid && history.length >= horizon ? completeTotal(history.slice(-horizon)) : null;
  const growth = valid && recent !== null && recent > 0 ? (total / recent - 1) * 100 : null;
  const peakIndex = valid ? values.indexOf(Math.max(...values)) : -1;
  const lower = forecastNumber(entry?.forecast?.lower?.[peakIndex]);
  const upper = forecastNumber(entry?.forecast?.upper?.[peakIndex]);
  const hasRange = lower !== null && upper !== null && lower >= 0 && upper >= lower;
  return {
    horizon, total: valid ? total : null, recent, growth,
    peak: peakIndex < 0 ? null : values[peakIndex],
    peakLabel: labels[peakIndex] || null,
    // Marginal quantiles are NOT additive across periods. Show the interval
    // for the busiest mean-demand period, never a fabricated horizon band.
    peakLower: hasRange ? lower : null, peakUpper: hasRange ? upper : null,
    historyPeriods: history.length,
    wape: forecastNumber(entry?.accuracy?.wape),
    mase: forecastNumber(entry?.accuracy?.mase),
    folds: forecastNumber(entry?.accuracy?.n_folds),
  };
}

export function forecastPeriodUnit(frequency) {
  return ({ DAY: 'day', WEEK: 'week', MONTH: 'month', QUARTER: 'quarter' })[frequency] || 'period';
}
