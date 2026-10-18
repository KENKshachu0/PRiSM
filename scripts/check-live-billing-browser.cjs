const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.PRISM_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const output = process.env.PRISM_SCAN_OUTPUT || '.scan-check';
fs.mkdirSync(output, { recursive: true });
const capturedAt = '2026-10-07T10:00:00.000Z', startedAt = '2026-09-07T10:00:00.000Z';
const shop = { id: 'shop', publicId: 'demo', name: '长期账单测试', timeZone: 'Asia/Shanghai', billingEnabled: true };
function data(unitPrice, broken) {
  const config = { id: 'rate', version: 1, versionId: 'v1', kind: 'time.priority', name: 'Original', enabled: true, status: 'active', createdAt: startedAt, updatedAt: startedAt,
    provider: { id: 'provider', timeZone: 'UTC', rules: [{ id: 'day', label: 'Day', priority: 1, timeRange: { start: '02:00', end: '19:00' }, pricing: { unitMinutes: 60, unitPrice, roundGraceMinutes: 10, priceCap: 90 } }] } };
  const players = Array.from({ length: 16 }, (_, i) => ({ playerId: 'p' + i, displayName: 'Player ' + i, status: 'active', walletTotal: 9999, stayDurationMinutes: 43200, estimatedTotal: null, globalCapWindows: [],
    identities: [{ provider: 'web-account', subject: 'account-' + i, displayName: 'Account ' + i }],
    sessions: [{ id: 's' + i, label: 'entry', startedAt: '2026-09-07T18:00:00.000+08:00', endedAt: null, status: 'active', elapsedMinutes: 43200, currentImpact: null, pricingCharges: [], pricingSegments: [] }] }));
  return { players, billingSnapshot: { version: 1, capturedAt, currentPricingConfigs: [config], pricingReleases: [{ id: 'release', timeZone: 'UTC', configs: [config] }],
    assetDefinitions: [{ type: 'currency', code: 'paid', name: 'Paid', stackable: true, metadata: null }],
    players: players.map((player, i) => ({ playerId: player.playerId, sessions: [{ id: 's' + i, playerId: player.playerId, label: 'entry', startedAt, status: 'active', paymentStatus: 'unpaid', pricingConfigIds: ['rate'], pricingReleaseId: broken && i === 15 ? 'missing' : 'release', metadata: {} }],
      holdings: [{ id: 'h' + i, assetType: 'currency', assetCode: 'paid', quantity: 999900 }], pastAppliedAdjustments: [], pricingPaidHistory: {}, capPaidHistory: {} })) } };
}
(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    // The computer zone deliberately differs from the merchant shop zone.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'America/New_York' });
    const errors = [], requests = [];
    let unitPrice = 18, broken = true, loads = 0;
    await page.addInitScript(() => {
      const Original = window.Worker;
      window.workerStarts = 0; window.workerStops = 0;
      window.Worker = class extends Original {
        constructor(...args) { super(...args); window.workerStarts++; }
        terminate() { window.workerStops++; super.terminate(); }
      };
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      requests.push({ path: pathname, url: req.url(), method: req.method(), body: req.postData() });
      let body;
      if (pathname === '/api/v1/me') body = { user: { id: 'owner', username: 'owner', displayName: '店员', role: 'user', hasShops: true } };
      else if (pathname === '/api/v1/merchant/shops') body = { shops: [shop] };
      else if (pathname === '/api/v1/shops/demo') body = { shop };
      else if (pathname.endsWith('/staff/me')) body = { staff: { canWrite: true, role: 'manager' } };
      else if (pathname.endsWith('/staff/live-players')) { loads++; body = data(unitPrice, broken); }
      else if (pathname.endsWith('/billing-inputs')) {
        const playerId = pathname.split('/players/')[1].split('/')[0];
        const inputs = data(unitPrice, broken).billingSnapshot;
        inputs.players = inputs.players.filter(player => player.playerId === playerId);
        body = { playerId, billingSnapshot: inputs };
      }
      else if (pathname.endsWith('/checkout/preview')) body = { settlementPreview: { total: 777 }, chargeItems: [], adjustments: [], wallet: { balanceBefore: 9999, balanceAfter: 9222 } };
      else body = {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) });
    });
    await page.goto(origin + '/merchant/demo/live');
    // The list and the bill share one panel per selected player. The quote is
    // produced by a worker, so the first assertion waits for the panel itself.
    const panel = page.getByRole('region', { name: '玩家资料', exact: true });
    await panel.waitFor();
    // The amount appears in the list row and in the bill; match the bill's own
    // definition list so the assertion is about the selected player's quote.
    await panel.locator('dl dd').filter({ hasText: '2,790.00' }).first().waitFor({ timeout: 45000 });
    assert.equal(await page.getByRole('button', { name: /^Player / }).count(), 16);
    await page.getByRole('button', { name: /^Player 14 / }).getByText('2,790.00').first().waitFor();
    assert.equal(requests.filter(req => req.path.includes('checkout') || req.url.includes('playerId=')).length, 0);
    await page.getByRole('button', { name: /^Player 15 / }).click();
    await panel.getByRole('alert').waitFor();
    assert.match(await panel.getByRole('alert').textContent(), /账单预估失败/);
    broken = false;
    await panel.getByRole('button', { name: '重试', exact: true }).click();
    await panel.getByText('2,790.00').first().waitFor();
    assert.ok(loads >= 2);
    assert.ok(await page.evaluate(() => window.workerStops >= 1));
    // A refresh replaces all calculations; no old 2790 result may overwrite the new price.
    unitPrice = 0;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await panel.locator('dl dd').filter({ hasText: /^0\.00$/ }).waitFor();
    await page.getByRole('searchbox', { name: '搜索玩家' }).fill('Account 3');
    assert.equal(await page.getByRole('button', { name: /^Player / }).count(), 1);
    await panel.getByRole('heading', { name: 'Player 3' }).waitFor();
    await panel.getByRole('button', { name: '结账', exact: true }).click();
    const checkout = page.getByRole('dialog', { name: '结账', exact: true });
    await checkout.locator('.bill-total > strong').filter({ hasText: /^0\.00$/ }).waitFor();
    assert.equal(requests.filter(req => req.path.endsWith('/checkout/preview')).length, 0);
    assert.equal(requests.filter(req => req.path.endsWith('/billing-inputs')).length, 1);
    await checkout.getByRole('button', { name: '确认结账', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const confirmation = requests.find(req => req.path.endsWith('/checkout/confirm'));
    assert.deepEqual(Object.keys(JSON.parse(confirmation.body)), ['operationId']);
    assert.match(JSON.parse(confirmation.body).operationId, /^[0-9a-f-]{36}$/);
    await panel.locator('dl dd').filter({ hasText: /^0\.00$/ }).waitFor();
    // Both new actions reuse the existing browser preview and submit idempotent
    // server operations; cashier players remain on the separate cashier flow.
    await panel.getByRole('button', { name: '改价结账', exact: true }).click();
    const override = page.getByRole('dialog', { name: '改价结账', exact: true });
    await override.getByRole('spinbutton', { name: '最终应收金额' }).waitFor();
    assert.equal(await override.locator('.bill-total, .bill-timeline, .account-row').count(), 0);
    assert.equal(await override.getByRole('spinbutton').count(), 1);
    await override.getByRole('spinbutton', { name: '最终应收金额' }).fill('8.50');
    await override.getByRole('textbox', { name: '改价原因' }).fill('设备故障');
    await override.getByRole('button', { name: '确认改价结账', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    const overridden = requests.find(req => req.path.endsWith('/checkout/override'));
    assert.ok(overridden, 'override checkout request');
    assert.equal(JSON.parse(overridden.body).finalTotal, 8.5);
    assert.equal(JSON.parse(overridden.body).reason, '设备故障');
    assert.match(JSON.parse(overridden.body).operationId, /^[0-9a-f-]{36}$/);

    await panel.getByRole('button', { name: '充值结账', exact: true }).click();
    const recharge = page.getByRole('dialog', { name: '充值结账', exact: true });
    await recharge.getByRole('spinbutton', { name: '充值金额' }).waitFor();
    assert.equal(await recharge.locator('.bill-total, .bill-timeline, .account-row').count(), 0);
    assert.equal(await recharge.getByRole('spinbutton').count(), 1);
    await recharge.getByRole('spinbutton', { name: '充值金额' }).fill('88.50');
    await recharge.getByRole('button', { name: '确认充值并结账', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    const charged = requests.find(req => req.path.endsWith('/checkout/recharge'));
    assert.ok(charged, 'recharge checkout request');
    assert.equal(JSON.parse(charged.body).amount, 88.5);
    assert.match(JSON.parse(charged.body).operationId, /^[0-9a-f-]{36}$/);
    assert.equal(requests.filter(req => req.path.endsWith('/checkout/preview')).length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.screenshot({ path: path.join(output, 'live-billing-mobile.png') });
    const starts = await page.evaluate(() => window.workerStarts);
    await page.goto(origin + '/merchant/demo/players');
    assert.ok(starts > 0);
    assert.deepEqual(errors, []);
    console.log('Live billing browser checks passed: real workers, month-long visits, error isolation, refresh, shop timezone, account search and authoritative checkout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
