const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = process.env.PRISM_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const startedAt = '2026-10-02T02:08:00Z', capturedAt = '2026-10-02T03:54:00Z';
const shop = { id: 'shop', publicId: 'demo', name: '浏览器预览测试', timeZone: 'Asia/Shanghai', billingEnabled: true, cashierEnabled: true, locationEnabled: false };
const pricing = { id: 'rate', kind: 'time.priority', name: '基础计费', enabled: true, status: 'active', createdAt: startedAt, updatedAt: startedAt,
  provider: { id: 'rate', timeZone: 'UTC', rules: [{ id: 'day', label: '营业', priority: 1, timeRange: { start: '02:00', end: '19:00' }, pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 10, priceCap: 90 } }] } };
const session = { id: 'visit', playerId: 'p', label: 'entry', startedAt, status: 'active', paymentStatus: 'unpaid', pricingConfigIds: ['rate'], metadata: {} };
const inputs = { playerId: 'p', billingSnapshot: { version: 1, capturedAt, currentPricingConfigs: [pricing], pricingReleases: [], assetDefinitions: [],
  players: [{ playerId: 'p', sessions: [session], holdings: [], pastAppliedAdjustments: [], pricingPaidHistory: {}, capPaidHistory: {} }] } };
const profile = { id: 'p', displayName: '测试玩家', status: 'active', kind: 'type-a', uid: 'AABBCCDD', sessions: [session] };
(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'America/New_York' });
    const requests = [], errors = [];
    let failQuote = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem('prism.active-shop', 'demo'));
    await page.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      requests.push({ path: pathname, method: req.method(), body: req.postData() });
      let data;
      if (pathname === '/api/v1/me') data = { user: { id: 'owner', username: 'owner', displayName: '测试账号', role: 'user', hasShops: true } };
      else if (pathname === '/api/v1/merchant/shops') data = { shops: [shop] };
      else if (pathname === '/api/v1/shops/demo') data = { shop, membership: { playerId: 'p', identityBound: true }, entryPricing: [pricing], pricingSchedule: { clientCalculation: true, localDate: '2026-10-02', timeZone: shop.timeZone, groups: [] } };
      else if (pathname.endsWith('/staff/me')) data = { staff: { canWrite: true, role: 'manager' } };
      else if (pathname.endsWith('/staff/live-players')) data = { players: [] };
      else if (pathname.endsWith('/staff/pricing-configs')) data = { pricingConfigs: [pricing] };
      else if (pathname.endsWith('/player/me')) data = { player: { displayName: '测试玩家' }, wallet: [], activeSession: { id: 'visit', startedAt } };
      else if (pathname.endsWith('/billing-inputs')) {
        if (failQuote) {
          failQuote = false;
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'READ_FAILED', message: '预览输入暂不可用' } }) }); return;
        }
        data = inputs;
      } else if (pathname.endsWith('/cashier/profiles/p')) data = { profile };
      else if (pathname.endsWith('/checkout/confirm')) data = { playerSettlement: { total: 36 } };
      else if (pathname.endsWith('/checkout/preview') || pathname.endsWith('/pricing-timeline/preview')) throw new Error('Unexpected server calculation: ' + pathname);
      else data = {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    await page.goto(origin + '/merchant/demo/live?cashierPlayer=p');
    const cashier = page.getByRole('region', { name: '前台收银', exact: true });
    await cashier.locator('.bill-total > strong').filter({ hasText: /^36\.00$/ }).waitFor();
    assert.deepEqual(await cashier.locator('.bill-event time').allTextContents(), ['11:54', '10:08']);
    failQuote = true;
    await cashier.getByRole('button', { name: '刷新账单', exact: true }).click();
    await cashier.getByRole('alert').getByText('预览输入暂不可用', { exact: true }).waitFor();
    await cashier.getByRole('button', { name: '刷新账单', exact: true }).click();
    await cashier.getByRole('button', { name: '确认已收款并结账', exact: true }).waitFor({ state: 'visible' });
    await cashier.getByRole('checkbox', { name: '我已通过上述方式收到款项' }).check();
    await cashier.getByRole('button', { name: '确认已收款并结账', exact: true }).click();
    await cashier.getByText('已收款并结账', { exact: true }).waitFor();
    const collection = JSON.parse(requests.find(request => request.path.endsWith('/cashier/profiles/p/checkout/confirm')).body);
    assert.equal(collection.expectedTotal, 36);
    assert.equal(new Date(collection.previewedAt).toISOString(), new Date(capturedAt).toISOString());
    assert.deepEqual(collection.sessionIds, ['visit']);
    await page.goto(origin + '/merchant/demo/pricing');
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const ring = page.getByRole('region', { name: '当日预览' });
    await ring.locator('input[type="date"]').fill('2026-10-02');
    await ring.getByText('03:00–10:00', { exact: true }).waitFor();
    // A period running through midnight is one row, as the day strip draws it in two pieces.
    assert.ok(await ring.getByText('10:00–03:00', { exact: true }).isVisible());
    assert.equal(await ring.getByText('00:00–03:00', { exact: true }).count(), 0);
    // The player account bill uses the device zone; the same instant is 22:08 in New York.
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.player-account-menu summary').click();
    await page.locator('.player-menu-items').getByRole('button', { name: '账单', exact: true }).click();
    const account = page.locator('.player-dialog');
    await account.locator('.bill-total > strong').filter({ hasText: /^36\.00$/ }).waitFor();
    assert.deepEqual(await account.locator('.bill-event time').allTextContents(), ['23:54', '22:08']);
    await account.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(requests.filter(request => request.path.endsWith('/checkout/preview') || request.path.endsWith('/pricing-timeline/preview')).length, 0);
    assert.deepEqual(errors, []);
    console.log('Billing preview browser checks passed: real worker cashier/account quotes, retry, server confirm payload, merchant/device zones and local pricing ring.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
