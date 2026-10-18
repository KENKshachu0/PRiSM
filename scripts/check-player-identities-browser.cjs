const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.PRISM_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const output = process.env.PRISM_IDENTITIES_OUTPUT || '.scan-check';
const shop = { id: 'shop', publicId: 'demo', name: '身份测试店铺', timeZone: 'Asia/Shanghai', latitude: 31, longitude: 121, radiusMeters: 80 };
fs.mkdirSync(output, { recursive: true });

(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const errors = [], bindings = [];
    let canWrite = true;
    const players = [
      { id: 'cashier', paymentMode: 'cashier', displayName: '前台玩家', status: 'active', walletTotal: 0, activeSessionId: null,
        identities: [{ provider: 'web-account', subject: 'account-id', displayName: '绑定账号昵称' }] },
      { id: 'normal', displayName: '普通玩家', status: 'active', walletTotal: 100, activeSessionId: null,
        identities: [{ provider: 'web-account', subject: 'normal-id', displayName: '普通账号昵称' }] },
    ];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      let data;
      if (pathname === '/api/v1/me') data = { user: { id: 'owner', username: 'owner', displayName: '店员', role: 'user', hasShops: true } };
      else if (pathname === '/api/v1/merchant/shops') data = { shops: [shop] };
      else if (pathname === '/api/v1/shops/demo') data = { shop: { ...shop, billingEnabled: true, cashierEnabled: true } };
      else if (pathname.endsWith('/staff/me')) data = { staff: { canWrite, role: canWrite ? 'manager' : 'viewer' } };
      else if (pathname.endsWith('/staff/players')) data = { players };
      else if (pathname.endsWith('/staff/players/cashier/identities')) {
        const binding = req.postDataJSON();
        bindings.push(binding);
        players[0].identities.push({ provider: binding.provider, subject: binding.subject });
        data = { identity: binding };
      } else if (pathname.endsWith('/assets')) data = { holdings: [], ledgerEntries: [] };
      else if (pathname.endsWith('/sessions/history')) data = { sessions: [] };
      else if (pathname.endsWith('/asset-definitions')) data = { assetDefinitions: [] };
      else data = {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    });

    await page.goto(origin + '/merchant/demo/players');
    const panel = page.getByRole('region', { name: '玩家资料' });
    const rowFor = (name) => page.locator('main button[aria-pressed]').filter({ hasText: name });
    await rowFor('前台玩家').first().waitFor();
    await rowFor('前台玩家').first().click();
    await panel.getByRole('heading', { name: '前台玩家', exact: true }).waitFor();
    await panel.locator('summary').filter({ hasText: '身份与状态' }).click();
    assert.ok(await panel.getByText('PRiSM 账号:', { exact: false }).first().isVisible());
    assert.equal(await panel.getByRole('button', { name: '充值 / 扣款', exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: '发放资产', exact: true }).count(), 0);
    await panel.locator('input[name="provider"]').fill('onebot');
    await panel.locator('input[name="subject"]').fill('114514');
    await panel.getByRole('button', { name: '绑定平台身份', exact: true }).click();
    await panel.getByText('onebot:114514', { exact: true }).waitFor();
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].provider, 'onebot');
    assert.equal(bindings[0].subject, '114514');
    assert.equal(players[0].paymentMode, 'cashier');
    await panel.screenshot({ path: path.join(output, 'cashier-identities.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/merchant/demo/players');
    const mobileRow = page.locator('main button[aria-pressed]');
    await mobileRow.filter({ hasText: '前台玩家' }).first().waitFor();
    await page.getByRole('searchbox', { name: '搜索玩家' }).fill('绑定账号昵称');
    assert.equal(await mobileRow.filter({ hasText: '普通玩家' }).count(), 0);
    await mobileRow.filter({ hasText: '前台玩家' }).first().click();
    await panel.locator('summary').filter({ hasText: '身份与状态' }).click();
    assert.ok(await panel.locator('input[name="provider"]').isVisible());
    await panel.screenshot({ path: path.join(output, 'cashier-identities-mobile.png') });

    canWrite = false;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(origin + '/merchant/demo/players');
    await page.locator('main button[aria-pressed]').filter({ hasText: '前台玩家' }).first().click();
    await panel.locator('summary').filter({ hasText: '身份与状态' }).click();
    assert.equal(await panel.locator('input[name="provider"]').count(), 0);
    assert.ok(await panel.getByText('onebot:114514', { exact: true }).filter({ visible: true }).isVisible());
    assert.deepEqual(errors, []);
    console.log('Player identities browser checks passed: cashier binding, PRiSM accounts, mobile search and viewer permissions.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
