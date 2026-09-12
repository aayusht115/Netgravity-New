/** Shared summaries for Overview tiles and their individual deep dives.
 * Metrics and impacts come from the finding; mitigation is a suggested test,
 * never a claim that an unsolved change will deliver a particular benefit.
 */

function compact(text, maxLength = 240) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return clean.slice(0, maxLength).replace(/\s+\S*$/, '') + '…';
}

export function attentionSummary(record, kind = 'insight') {
  if (kind === 'action') {
    const field = record.displayLabel || 'the missing field';
    const impact = record.whatItUnlocks
      ? `Providing this data ${record.whatItUnlocks.replace(/[.!?]+$/, '')}.`
      : 'The affected analysis remains incomplete until this data is supplied.';
    return {
      issue: record.title || `Missing ${field}`,
      impact: compact(impact),
      mitigation: compact(`Request ${field} from the data owner, then upload it and rerun the analysis.`),
      steps: [record.subtitle || `Review where ${field} is missing.`,
        `Request or upload ${field}, then rerun the analysis to check that the gap is closed.`],
    };
  }
  const evidence = (record.evidence || []).slice(0, 2)
    .filter(row => row.display_value != null)
    .map(row => `${row.label}: ${row.display_value}`).join('; ');
  return {
    issue: record.title || 'Review this finding',
    // Prefer the full narrative: the legacy subtitle splitter truncates decimals.
    impact: compact(record.narrative || record.subtitle || evidence || 'No impact has been quantified for this finding yet.'),
    mitigation: record.mitigation || 'No specific intervention is supported by this finding. Use the evidence when comparing the next network decision.',
    steps: record.mitigation ? [record.mitigation] : [],
  };
}

export function prioritizeAttention(items) {
  const priority = item => item.kind === 'action'
    ? (item.record.severity === 'REQUIRED' ? 0 : 3)
    : ({ RISK: 1, OPPORTUNITY: 2, INFORMATION: 4 }[item.record.severity] ?? 4);
  return [...items].sort((a, b) => priority(a) - priority(b)
    || (a.record.rank || 0) - (b.record.rank || 0));
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function attentionTilesHtml(items) {
  if (!items.length) return '<div class="ov-attn-empty">No findings are available yet. Upload network data and run the analysis to see what needs attention.</div>';
  const ordered = prioritizeAttention(items);
  const top = ordered.slice(0, 3);
  const rest = ordered.slice(3);
  const tiles = top.map(item => {
    const summary = attentionSummary(item.record, item.kind);
    const priority = item.record.severity === 'RISK' || item.record.severity === 'REQUIRED' ? 'critical'
      : item.record.severity === 'OPPORTUNITY' ? 'opportunity' : 'information';
    const label = priority === 'critical' ? 'High priority · supported risk or required data'
      : priority === 'opportunity' ? 'Lower priority · opportunity to evaluate' : 'Context · no critical risk identified';
    return `<article class="ov-attention-tile" data-priority="${priority}" data-kind="${escape(item.kind)}" data-id="${escape(item.id)}">
      <div class="ov-priority">${label}</div>
      <div><p class="ov-tile-label">Needs attention</p><h3>${escape(summary.issue)}</h3></div>
      <div><p class="ov-tile-label">Impact</p><p class="ov-tile-copy">${escape(summary.impact)}</p></div>
      <div class="ov-tile-mitigation"><p class="ov-tile-label">Suggested mitigation</p><p class="ov-tile-copy">${escape(summary.mitigation)}</p></div>
      <button type="button" class="ov-attn-more-link" data-attention-open data-kind="${escape(item.kind)}" data-id="${escape(item.id)}"
        aria-label="Deep dive: ${escape(summary.issue)}">Deep dive <span aria-hidden="true">→</span></button>
    </article>`;
  }).join('');
  const more = rest.length ? `<details class="ov-attn-rest">
    <summary>More findings and data requests (${rest.length})</summary>
    <div class="ov-attn-rest-list">${rest.map(item => `<button type="button" class="ov-attn-rest-item" data-attention-open data-kind="${escape(item.kind)}" data-id="${escape(item.id)}">
      <span class="ov-attn-rest-title">${escape(item.record.title)}</span><span>Deep dive →</span></button>`).join('')}</div>
  </details>` : '';
  return `<div class="ov-attention-grid">${tiles}</div>${more}`;
}
