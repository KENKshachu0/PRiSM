const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.PRISM_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const output = process.env.PRISM_SHOP_DATA_OUTPUT || '.scan-check';
fs.mkdirSync(output, { recursive: true });
const shop = { id: 'shop', publicId: 'demo', name: '目标测试店铺', timeZone: 'Asia/Tokyo', latitude: 35, longitude: 139, radiusMeters: 80 };
const backup = {
  format: 'prism-shop-data', version: 2, shopProfile: { name: "来源店铺", latitude: 31.23, longitude: 121.47, radiusMeters: 80, heroData: null }, scope: 'business', exportedAt: '2026-10-06T02:08:00.000Z',
  source: { publicId: 'beta-shop', name: '来源店铺', timeZone: 'Asia/Shanghai', origin: 'https://beta.example.com' },
  storage: { timeZone: 'UTC', money: 'minor-units' }, settings: {},
  tables: { players: [{ id: 'p', display_name: '玩家' }], asset_holdings: [{ quantity: 12345 }], sessions: [{ started_at: '2026-10-06T02:08:00.000Z' }] },
};
(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'America/Los_Angeles' });
    const errors = [], applies = [], previews = [], exports = [], uploads = [], headers = [];
    let canImport = false, owner = true, imported = false, platformAdmin = false, remaining = 100, importRemaining = 100;
    const allowanceSaves = [], cancellations = [];
    let activeExport = null, holdFinalPage = false, releaseFinalPage, exportStatusFailures = 0;
    const lockedMessage = '店铺正在导出数据，暂时不能进行业务操作，请稍后重试';
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
      let data;
      if (pathname.endsWith('/data/export-status')) {
        if (exportStatusFailures-- > 0) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '操作失败，请稍后重试' } }) });
        data = { remaining, used: exports.length, importRemaining, locked: !!activeExport, activeExport };
      } else if (pathname.endsWith('/data/exports')) {
        exports.push(req.postDataJSON().scope);
        activeExport = { jobId: 'export-' + exports.length, expiresAt: new Date(Date.now() + 300000).toISOString(), scope: req.postDataJSON().scope };
        const { tables, ...header } = backup;
        data = { jobId: 'export-' + exports.length, headerJson: JSON.stringify(header), tables: Object.keys(tables),
          counts: Object.fromEntries(Object.entries(tables).map(([t,r])=>[t,r.length])), filename: 'prism-beta-shop.json' };
      } else if (/\/data\/exports\/[^/]+(?:\/cancel)?$/.test(pathname) && ['DELETE','POST'].includes(req.method())) {
        const id = pathname.split('/')[7];
        cancellations.push([id, req.method()]);
        if (activeExport?.jobId === id) activeExport = null;
        releaseFinalPage?.(); releaseFinalPage = undefined;
        data = { deleted: true };
      } else if (/\/data\/exports\/[^/]+\/page$/.test(pathname)) {
        const after = Number(url.searchParams.get('after') || '0');
        if (after && holdFinalPage) await new Promise(resolve => { releaseFinalPage = resolve; });
        if (after && activeExport?.jobId === pathname.split('/')[7]) activeExport = null;
        const rows = Object.entries(backup.tables).flatMap(([table,values])=>values.map(row=>({ table_name: table, payload_json: JSON.stringify(row) }))).map((r,i)=>({ ...r,seq:i+1 }));
        data = { rows: after ? [] : rows, cursor: after || rows.length, done: !!after };
      } else if (pathname.endsWith('/data/imports')) {
        headers.push(req.postDataJSON());
        data = { jobId: 'import-' + headers.length, tables: Object.keys(backup.tables) };
      } else if (/\/data\/imports\/[^/]+\/parts$/.test(pathname)) {
        uploads.push(req.postDataJSON()); data = { accepted: true };
      } else if (/\/data\/imports\/[^/]+\/preview$/.test(pathname)) {
        previews.push(req.postDataJSON());
        data = { canImport, fingerprint: 'a'.repeat(43), scope: 'business', source: backup.source,
          counts: { players: 1, asset_holdings: 1, asset_ledger_entries: 27, sessions: 1 },
          target: { records: 73, mode: 'replace' },
          errors: canImport ? [] : ['备份文件未完整上传或数据表不完整'],
          warnings: ['将恢复完整店铺资料、设置、设备连接及业务记录。目标店铺编号和当前管理员保留。'] };
      } else if (/\/data\/imports\/[^/]+\/apply$/.test(pathname)) {
        applies.push(req.postDataJSON());
        if (applies.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '操作失败，请稍后重试' } }) });
        imported = true; data = { imported: true };
      } else if (pathname === '/api/v1/me') data = { user: { id: 'owner', username: 'owner', displayName: '店主', role: platformAdmin ? 'admin' : 'user', hasShops: true } };
      else if (pathname === '/api/v1/admin/users') data = { users: [] };
      else if (pathname === '/api/v1/admin/bans') data = { bans: [] };
      else if (pathname.endsWith('/transfer-allowance')) {
        if (req.method() === 'PUT') allowanceSaves.push(req.postDataJSON());
        const saved = allowanceSaves.at(-1) || { extra: 0, importExtra: 0 };
        data = { month: '2026-10', timeZone: 'Asia/Shanghai', allowance: 1 + saved.extra, used: 1,
          remaining: saved.extra, importAllowance: 1 + saved.importExtra, importUsed: 1, importRemaining: saved.importExtra };
      }
      else if (pathname === '/api/v1/merchant/shops') data = { shops: [{ ...shop, name: imported ? '来源店铺' : shop.name }] };
      else if (pathname === '/api/v1/merchant/shop-members') data = { members: [] };
      else if (pathname === '/api/v1/shops/demo') data = { shop: { ...shop, billingEnabled: imported, cashierEnabled: false } };
      else if (pathname.endsWith('/staff/me')) data = { staff: { canWrite: owner, role: owner ? 'owner' : 'viewer' } };
      else if (pathname.endsWith('/staff/live-players')) data = { players: [] };
      else if (pathname.endsWith('/staff/players')) data = { players: [] };
      else if (pathname.endsWith('/staff/pricing-configs')) data = { pricingConfigs: [] };
      else if (pathname.endsWith('/staff/presents')) data = { presents: [] };
      else if (pathname.endsWith('/staff/api-tokens')) data = { apiTokens: [] };
      else if (pathname.endsWith('/staff/settings')) data = { settings: {
        store: { name: shop.name, timeZone: shop.timeZone }, operations: { coinCooldownMs: 60000 }, registration: { defaultPresentId: null },
        homeAssistantConnection: { url: '', token: '' }, homeAssistantDevices: [], ttLockDevices: [], hinataIoDevices: [],
      } };
      else if (pathname.endsWith('/settings')) data = { billingEnabled: imported, cashierEnabled: false, autoRegister: true, identityBindingRequired: true,
        locationEnabled: false, checkinGeo: false, checkoutGeo: false, machineGeo: false, entryPricingIds: [], botContact: '',
        billingConfiguration: { ready: false, balanceAssetsReady: false, entryPricingReady: false, invalidEntryPricingIds: [] } };
      else data = {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    await page.goto(origin + '/merchant/demo/settings?group=data');
    const download = page.getByRole('button', { name: '下载 JSON 文件', exact: true });
    await download.waitFor();
    assert.equal(await page.getByRole('button', { name: '开始导入', exact: true }).isEnabled(), false);
    const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
    assert.equal(file.suggestedFilename(), 'prism-beta-shop.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(await file.path(), 'utf8')), backup);
    assert.deepEqual(exports, ['business']);
    await page.locator('select').filter({ has: page.getByRole('option', { name: '仅店铺配置（不含玩家和账单）', exact: true }) }).selectOption('configuration');
    await Promise.all([page.waitForEvent('download'), download.click()]);
    assert.deepEqual(exports, ['business', 'configuration']);
    // Keep the last page pending so progress must appear before the file is downloaded.
    holdFinalPage = true;
    await download.click();
    await page.getByText('已导出记录: 3 / 3', { exact: true }).waitFor();
    assert.equal(await page.getByRole('progressbar', { name: '导出进度', exact: true }).getAttribute('value'), '3');
    await page.screenshot({ path: path.join(output, 'shop-data-export-progress.png'), fullPage: true });
    const interruptedId = activeExport.jobId, starts = exports.length;
    await page.reload();
    holdFinalPage = false;
    await download.waitFor();
    await page.waitForFunction(() => !sessionStorage.getItem('prism.export:/api/v1/shops/demo/data'));
    assert.equal(activeExport, null);
    assert.ok(cancellations.some(([id]) => id === interruptedId));
    assert.equal(exports.length, starts, 'Reload must not start a fresh monthly export');
    assert.equal(await page.getByText(lockedMessage, { exact: true }).count(), 0);
    // Older interrupted jobs have no tab checkpoint: the shop owner can still cancel them.
    activeExport = { jobId: 'old-interrupted-job', scope: 'business', expiresAt: new Date(Date.now()+300000).toISOString() };
    await page.reload();
    await page.getByText(lockedMessage, { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消导出，恢复营业', exact: true }).click();
    await page.getByText(lockedMessage, { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(activeExport, null);
    // Querying the lock does not renew it: expired leases disappear without another page reload.
    activeExport = { jobId: 'expires', scope: 'business', expiresAt: new Date(Date.now()+1000).toISOString() };
    await page.reload();
    await page.getByText(lockedMessage, { exact: true }).waitFor();
    activeExport = null; exportStatusFailures = 1;
    await page.getByText(lockedMessage, { exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    const input = page.getByLabel('JSON 备份文件', { exact: true });
    await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '请选择有效的 JSON 备份文件' }).waitFor();
    // A valid file verifies entirely in the browser: confirming comes first and
    // cancelling sends nothing.
    await input.setInputFiles({ name: 'beta-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认导入店铺数据', exact: true });
    await dialog.waitFor();
    assert.equal(headers.length, 0, 'confirmation must come before any upload');
    assert.equal(uploads.length, 0);
    assert.equal(previews.length, 0);
    assert.equal(await dialog.getByRole('button', { name: '确认导入', exact: true }).isEnabled(), false);
    await page.screenshot({ path: path.join(output, 'shop-data-desktop.png'), fullPage: true });
    canImport = false;
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('alert').filter({ hasText: '备份文件未完整上传或数据表不完整' }).waitFor();
    const { tables, ...header } = backup;
    assert.deepEqual(headers[0], header);
    assert.equal(headers.length, 1, 'retrying must reuse staging and monthly allowance');
    assert.equal(uploads.length, 3);
    assert.deepEqual(previews[0], { counts: Object.fromEntries(Object.entries(tables).map(([t,r])=>[t,r.length])), parts: 3 });
    assert.deepEqual(uploads.slice(0,3).map(p=>[p.table,p.rows]), Object.entries(tables));
    canImport = true; importRemaining = 0;
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: '确认导入', exact: true }).isEnabled(), false);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('alert').filter({ hasText: '操作失败，请稍后重试' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    await dialog.waitFor();
    await page.screenshot({ path: path.join(output, 'shop-data-mobile-confirm.png'), fullPage: true });
    assert.equal(await dialog.getByRole('button', { name: '确认导入', exact: true }).isEnabled(), false);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await page.getByText('导入完成，请核对玩家、余额、账单及资源设置后再营业。', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: '切换店铺', exact: true }).getByRole('option', { name: '来源店铺', exact: true }).waitFor({ state: 'attached' });
    assert.equal(applies.length, 2);
    assert.deepEqual(applies[0], applies[1]);
    assert.equal(applies[1].backup, undefined);
    assert.ok(applies[1].operationId);
    assert.equal(applies[1].overwrite, true);
    assert.equal(headers.length, 1, 'all retries must reuse the single staged job');
    assert.equal(uploads.length, 3, 'retrying must not re-upload the file');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.evaluate(() => localStorage.setItem('prism.locale', 'en'));
    await page.reload();
    await page.getByRole('button', { name: 'Download JSON file', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Data management', exact: true }).waitFor();
    owner = false; await page.reload();
    await page.getByRole('combobox', { name: 'Switch store', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Download JSON file', exact: true }).count(), 0);
    owner = true; remaining = 0; importRemaining = 0;
    await page.goto(origin + '/merchant/demo/settings?group=data');
    await page.getByRole('button', { name: 'Download JSON file', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Download JSON file', exact: true }).isEnabled(), false);
    await page.getByLabel('JSON backup file', { exact: true }).setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    assert.equal(await page.getByRole('button', { name: 'Start import', exact: true }).isEnabled(), false);
    platformAdmin = true;
    await page.evaluate(() => localStorage.setItem('prism.locale', 'zh'));
    await page.goto(origin + '/admin');
    await page.getByLabel('店铺编号', { exact: true }).fill('demo');
    await page.getByRole('button', { name: '查询额度', exact: true }).click();
    await page.getByLabel('当月额外导出次数', { exact: true }).fill('2');
    await page.getByLabel('当月额外导入次数', { exact: true }).fill('3');
    await page.getByRole('button', { name: '保存额度', exact: true }).click();
    await page.getByText('本月剩余导入次数: 3', { exact: true }).waitFor();
    assert.deepEqual(allowanceSaves, [{ extra: 2, importExtra: 3 }]);
    await page.screenshot({ path: path.join(output, 'shop-data-admin-allowance.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: 'paged UTC JSON download, live export progress, reload cancellation and tab recovery, manual recovery of old interrupted jobs, lease expiry polling after a transient status failure, streamed upload, business/configuration scopes, invalid files, failed preflight, source identification and counts, confirmation, same-operation retries, mobile and English UI, owner-only access, exhausted monthly allowances, administrator import/export grants', errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
