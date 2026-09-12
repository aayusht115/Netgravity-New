/** Isolated UI regression: no credentials, backend writes or persisted demo data.
 * Usage: NODE_PATH=<playwright node_modules> node scripts/verify_overview_ui.cjs
 *        [base URL, default http://127.0.0.1:3012] [screenshot directory]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const baseURL = process.argv[2] || 'http://127.0.0.1:3012';
const output = process.argv[3];
const findings = [
  { id: 'TEST_SERVICE', headline: 'Service shortfall needs attention', severity: 'RISK', theme: 'Service', rank: 1,
    narrative: 'Service is 93.5%; 650 units of demand remain unserved in the current plan.',
    evidence: [{ label: 'Service level', display_value: '93.5%', value: 93.5, unit: 'percent', source: 'Test fixture' },
      { label: 'Unserved demand', display_value: '650 units', value: 650, unit: 'units', source: 'Test fixture' }] },
  { id: 'TEST_CAPACITY', headline: 'Two sites are approaching capacity', severity: 'RISK', theme: 'Capacity', rank: 2,
    narrative: 'East is at 97.2% utilisation and West at 92.4%, leaving limited capacity for additional demand.',
    evidence: [{ label: 'Highest utilisation', display_value: '97.2%', value: 97.2, unit: 'percent', source: 'Test fixture' }],
    entities: [{ entity_id: 'EAST', label: 'East', kind: 'DC', value: 97.2, metric: 'utilization_pct' },
      { entity_id: 'WEST', label: 'West', kind: 'DC', value: 92.4, metric: 'utilization_pct' }] },
  { id: 'TEST_COST', headline: 'Transport dominates the cost mix', severity: 'OPPORTUNITY', theme: 'Cost structure', rank: 3,
    narrative: 'Transport accounts for 700,000 of the 1,000,000 total cost. A changed plan has not yet been solved.',
    evidence: [{ label: 'Transport cost', display_value: '700,000', value: 700000, unit: 'INR', source: 'Test fixture' },
      { label: 'Other costs', display_value: '300,000', value: 300000, unit: 'INR', source: 'Test fixture' }] },
  { id: 'TEST_INFO', headline: 'Carbon baseline is available', severity: 'INFORMATION', theme: 'Carbon', rank: 4,
    narrative: 'The current baseline reports 4,200 kg CO2e.', evidence: [] },
];

(async () => {
  // Pure rendering checks cover incomplete records, ordering and safe escaping.
  const source = fs.readFileSync(path.join(__dirname, '../app/frontend/js/overview-attention.js'), 'utf8');
  const { attentionSummary, attentionTilesHtml, prioritizeAttention } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.match(attentionSummary({ title: 'A', narrative: 'Service is 93.5%.', subtitle: 'Service is 93.' }).impact, /93\.5%/);
  assert.match(attentionSummary({ title: 'No measurement' }).impact, /No impact has been quantified/);
  assert.equal(attentionSummary({ whatItUnlocks: 'would enable carbon analysis.' }, 'action').impact,
    'Providing this data would enable carbon analysis.');
  const unsafe = attentionTilesHtml([{ kind: 'insight', id: '"><script>', record: { title: '<img src=x onerror=alert(1)>' } }]);
  assert(!unsafe.includes('<script>') && !unsafe.includes('<img'));
  assert.match(attentionTilesHtml([]), /No findings are available yet/);
  assert.equal(prioritizeAttention([
    { kind: 'insight', record: { severity: 'INFORMATION' } },
    { kind: 'insight', record: { severity: 'RISK' } },
    { kind: 'action', record: { severity: 'REQUIRED' } },
  ])[0].kind, 'action');

  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    // All API calls intercepted in this browser context, even against a live URL.
    await context.route('**/api/**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', projects: [], insights: [], actions: [] }),
    }));
    await context.route('**/orchestrator/**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '{}',
    }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.renderHome === 'function' && typeof window.showInsightDetail === 'function');
    await page.evaluate(async (insights) => {
      const d = await import('/js/data.js');
      d.setAuthoritativeBaseline({ source: 'AUTHORITATIVE_KPI_LAYER', baseline: {
        totalCost: 1000000, avgUtilization: 87.3, sla: 93.5, carbonKgCo2e: 4200, unservedDemand: 650, totalDemand: 10000,
      } });
      d.setNetworkPeriods(['2026-09'], 'month');
      window.initHomeSelectors();
      window.__ngAnalysisComputedAt = Date.now() / 1000;
      document.getElementById('topbar-current-project-name').textContent = 'UI test network';
      d.applyInsightResponse({ scope: 'NETWORK', insights, thresholds: { utilization_over_pct: 90 },
        series: { cost_components: [{ label: 'Transport', value: 700000 }, { label: 'Other', value: 300000 }] } });
      for (const id of ['landing-page', 'select-project-page', 'create-project-page']) {
        const el = document.getElementById(id);
        if (el) { el.classList.add('hidden'); el.style.display = 'none'; }
      }
      document.querySelector('.app-shell').style.display = 'flex';
      window.navigateToTab('home');
      window.renderHome();
    }, findings);
    const tiles = page.locator('.ov-attention-tile');
    assert.equal(await tiles.count(), 3);
    const boxes = await tiles.evaluateAll(nodes => nodes.map(n => {
      const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
    }));
    assert.equal(boxes[0].y, boxes[1].y);
    assert.equal(boxes[1].y, boxes[2].y);
    assert(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x);
    assert(Math.abs(boxes[0].width - boxes[2].width) < 1);
    const filters = await page.locator('#home-top-controls').boundingBox();
    const kpis = await page.locator('#ov-kpi-strip').boundingBox();
    assert(filters && kpis && filters.y + filters.height <= kpis.y && kpis.y + kpis.height < boxes[0].y);
    assert(kpis.y + kpis.height < 1000);
    assert.equal(await page.locator('#tab-home #home-map-twin').count(), 0);
    assert.equal(await page.locator('#tab-twin #twin3d-canvas').count(), 1);
    assert.match(await tiles.first().innerText(), /93\.5%/);
    if (output) await page.screenshot({ path: path.join(output, 'overview-desktop.png'), fullPage: true });

    for (const [i, finding] of findings.slice(0, 3).entries()) {
      await tiles.nth(i).getByRole('button', { name: `Deep dive: ${finding.headline}`, exact: true }).click();
      const detail = page.locator('#tab-insight-detail');
      assert.equal(await detail.locator('h1').innerText(), finding.headline);
      assert.match(await detail.innerText(), /Suggested mitigation/);
      assert((await detail.innerText()).includes(finding.evidence[0].display_value));
      assert.equal(await detail.locator('.insd-mitigation-steps li').count(), 2);
      await detail.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
      if (i === 1) {
        await page.waitForFunction(() => typeof Chart !== 'undefined' && !!Chart.getChart('insd-trend-chart'));
        await page.waitForFunction(() => !Chart.getChart('insd-trend-chart').animating);
        assert.deepEqual(await page.evaluate(() => Chart.getChart('insd-trend-chart').data.labels), ['East', 'West']);
        await page.waitForFunction(() => Chart.getChart('insd-trend-chart').getDatasetMeta(0).data.every(bar => bar.height > 10));
        if (output) await page.screenshot({ path: path.join(output, 'capacity-deep-dive.png'), fullPage: true, animations: 'disabled' });
      }
      await page.locator('#insd-back-btn').click();
    }
    await page.locator('.ov-attn-rest summary').click();
    await page.locator('[data-attention-open][data-id="TEST_INFO"]').click();
    assert.equal(await page.locator('.insd-title').innerText(), findings[3].headline);
    assert.match(await page.locator('#tab-insight-detail').innerText(), /monitor this measure/);
    await page.locator('#insd-back-btn').click();

    await tiles.first().getByRole('button').click();
    await page.locator('#insd-run-scenario').click();
    assert(await page.locator('#tab-scenarios').evaluate(el => el.classList.contains('active')));
    await page.evaluate(() => window.navigateToTab('home'));

    // Missing data is a real attention item, with a distinct data-request deep dive.
    await page.evaluate(async () => {
      const d = await import('/js/data.js');
      d.applyActionsResponse({ actions: [{ id: 'TEST_MISSING', severity: 'REQUIRED', title: 'Capacity data is missing',
        subtitle: 'East is missing rated capacity.', display_label: 'Rated capacity', what_it_unlocks: 'would let us check capacity constraints',
        entity_type: 'DC', entity_type_plural: 'DCs', entities: [{ id: 'EAST', name: 'East' }] }] });
      window.renderHome();
    });
    assert.match(await tiles.first().innerText(), /Capacity data is missing/);
    await tiles.first().getByRole('button').click();
    assert.equal(await page.locator('.insd-title').innerText(), 'Capacity data is missing');
    assert.match(await page.locator('#tab-insight-detail').innerText(), /East/);
    assert.match(await page.locator('#tab-insight-detail').innerText(), /Suggested mitigation/);
    await page.locator('#insd-back-btn').click();

    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const stacked = await tiles.evaluateAll(nodes => nodes.map(n => {
        const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }));
      assert(stacked[0].bottom <= stacked[1].y && stacked[1].bottom <= stacked[2].y);
      assert(stacked.every(r => r.x >= 0 && r.right <= width + 1));
      const scope = await page.locator('#home-top-controls').boundingBox();
      const actions = await page.locator('.topbar-right-area').boundingBox();
      assert(scope.y + scope.height <= actions.y, 'Filters must not overlap toolbar actions');
      if (output) await page.screenshot({ path: path.join(output, `overview-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.evaluate(async () => {
      const d = await import('/js/data.js');
      d.applyActionsResponse({ actions: [] });
      d.applyInsightResponse({ scope: 'NETWORK', insights: [] });
      d.setAuthoritativeBaseline(null);
      window.renderHome();
    });
    assert.equal(await tiles.count(), 0);
    assert.match(await page.locator('#ov-attn-body').innerText(), /No findings are available yet/);
    assert.equal(await page.locator('.home2-kpi-strip-value').allTextContents().then(v => v.filter(t => t === '—').length), 4);
    assert.deepEqual(errors, [], 'Unexpected browser exceptions');
    console.log('PASS: ordering, three tiles, all deep dives, charts, missing data, disclosure, responsive layout, empty state and safe rendering.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
