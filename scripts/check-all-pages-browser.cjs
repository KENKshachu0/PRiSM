const { chromium, webkit } = require(process.env.PRISM_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Real Chromium + no network-backed API requests. Traverse the published routes
 * with role-specific fixtures, report blank screens, runtime errors and API drift.
 * This test must complement (not replace) the real D1 endpoint contract tests.
 */
const origin = process.env.PRISM_BROWSER_ORIGIN || "http://127.0.0.1:4173";
const output = process.env.PRISM_SCAN_OUTPUT || ".scan-check";
const browserEngine = process.env.PRISM_BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "webkit"].includes(browserEngine), `Unsupported browser: ${browserEngine}`);
const shop = {
  id: "shop", publicId: "demo", name: "CI 测试店铺", timeZone: "Asia/Shanghai",
  latitude: 31.23, longitude: 121.47, radiusMeters: 80, billingEnabled: true,
  cashierEnabled: false, identityBindingRequired: false, locationEnabled: false,
};
const live = {
  playerId: "p", displayName: "在店测试玩家", status: "active", walletTotal: 100,
  stayDurationMinutes: 65, estimatedTotal: null, identities: [],
  globalCapWindows: [],
  sessions: [{
    id: "s1", label: "entry", startedAt: "2026-10-02T02:08:00Z", endedAt: null,
    elapsedMinutes: 65, currentImpact: null, pricingCharges: [], pricingSegments: [],
    status: "active",
  }],
};
const snapshot = {
  version: 1, capturedAt: "2026-10-02T03:15:00Z", assetDefinitions: [],
  currentPricingConfigs: [], pricingReleases: [],
  players: [{
    playerId: "p", sessions: [{
      id: "s1", playerId: "p", startedAt: "2026-10-02T02:08:00Z",
      label: "entry", status: "active", paymentStatus: "unpaid",
      pricingConfigIds: [], metadata: {},
    }],
    holdings: [], pastAppliedAdjustments: [], pricingPaidHistory: {}, capPaidHistory: {},
  }],
};
const storeSettings = {
  store: { name: shop.name, timeZone: shop.timeZone },
  operations: { coinCooldownMs: 60000 },
  registration: { defaultPresentId: null },
  homeAssistantConnection: { url: "", token: "" }, homeAssistantDevices: [],
  ttLockDevices: [], hinataIoDevices: [],
};

function mock(request, role, unknown, mutations) {
  const url = new URL(request.url()), p = url.pathname, method = request.method();
  const owner = role === "owner" || role === "admin";
  if (method !== "GET") {
    // Explicitly whitelist mutations as tests add actions; never hide a changed API.
    mutations.push(method + " " + p);
    if (p === "/api/v1/cards/sync") return { cards: [], authorizationRequired: false, syncError: null };
    unknown.push(method + " " + p + url.search);
    return null;
  }
  if (p === "/api/v1/me") return { user: role === "guest" ? null : {
    id: role, username: role, displayName: role, role: role === "admin" ? "admin" : "user", hasShops: role !== "player",
  }};
  if (p === "/api/v1/cards") return { cards: [], authorizationRequired: false, syncError: null };
  if (p === "/api/v1/account") return {
    identities: [{ id: "ci-identity", provider: "munet", username: "ci-account", displayName: "CI 绑定账号", createdAt: "2026-10-02T02:08:00Z" }],
    passkeys: [{ id: "ci-passkey", name: "CI Passkey", deviceType: "singleDevice", backedUp: 0, createdAt: "2026-10-02T02:08:00Z" }],
  };
  if (p === "/api/v1/merchant/shops") return { shops: [shop] };
  if (p === "/api/v1/merchant/machines") return { machines: [] };
  if (p === "/api/v1/merchant/resource-groups") return { resourceGroups: [{ id: "default", name: "默认资源组", enabled: true, isDefault: true, defaultPricingConfigId: null, resourceCount: 0 }] };
  if (p === "/api/v1/merchant/machines/occupancy") return { resources: [] };
  if (p === "/api/v1/merchant/device-bindings") return { bindings: [] };
  if (p === "/api/v1/merchant/ha-connections") return { connections: [] };
  if (p === "/api/v1/merchant/idle-power") return { settings: { shopEmpty: { enabled: false, minutes: 15 }, device: { defaultMinutes: 0, whileOccupied: "mark" }, devices: {} } };
  if (p === "/api/v1/merchant/shop-members") return { members: [] };
  if (p === "/api/v1/admin/users") return { users: [] };
  if (p === "/api/v1/admin/bans") return { bans: [] };
  if (p === "/api/v1/shops/demo") return { shop, membership: { playerId: "p", identityBound: true }, entryPricing: [] };
  if (p === "/api/v1/shops/demo/settings") return {
    billingEnabled: true, cashierEnabled: false, identityBindingRequired: false,
    autoRegister: true, locationEnabled: false, checkinGeo: false, checkoutGeo: false,
    machineGeo: false, entryPricingIds: [], botContact: "",
    billingConfiguration: { ready: true, balanceAssetsReady: true, entryPricingReady: true, invalidEntryPricingIds: [] },
  };
  if (p === "/api/v1/shops/demo/player/me") return {
    player: { displayName: "在店测试玩家" }, wallet: [], activeSession: null,
  };
  if (p === "/api/v1/shops/demo/player/checkout/latest") return { receipt: null };
  if (p === "/api/v1/shops/demo/billing-members") return { members: [] };
  if (p === "/api/v1/shops/demo/data/export-status") return {
    remaining: 1, used: 0, importRemaining: 1, locked: false, activeExport: null,
  };
  const base = "/api/v1/shops/demo/staff/";
  if (p.startsWith(base)) {
    const action = p.slice(base.length);
    if (action === "me") return { staff: { id: "ci-staff", displayName: "CI 店员", role: owner ? "owner" : "viewer", canWrite: owner } };
    if (action === "live-players") return { players: [live], billingSnapshot: snapshot };
    if (action === "players") return { players: [
      {
        id: "p", displayName: live.displayName, status: "active", walletTotal: 125.95,
        identities: [], activeSessionId: "s1",
      },
      {
        id: "p-zero", displayName: "零余额玩家", status: "active", walletTotal: 0,
        identities: [], activeSessionId: null,
      },
    ] };
    if (action === "pricing-configs") return { pricingConfigs: [] };
    if (action === "asset-definitions") return { assetDefinitions: [] };
    if (action === "pricing-effects") return { pricingEffects: [] };
    if (action === "presents") return { presents: [] };
    if (action === "redeem-codes") return { redeemCodes: [] };
    if (action === "settings") return { settings: storeSettings };
    if (action === "api-tokens") return { apiTokens: [] };
    if (action === "reports/summary") return { summary: {
      revenueTotal: 0, sessionCount: 0, assetGrantTotal: 0, coinCommandCount: 0,
    }};
    if (action === "reports/checkouts") return { records: [], page: { hasMore: false } };
    if (action === "players/p/assets") return { holdings: [], ledgerEntries: [] };
    if (action === "players/p/sessions/history") return { sessions: [] };
  }
  unknown.push(method + " " + p + url.search);
  return null;
}

const cases = [
  { role: "guest", pages: [
    ["/login", "登录"], ["/t/demo", "CI 测试店铺"],
  ]},
  { role: "player", pages: [
    ["/cards", "卡片"], ["/settings", "账号"], ["/t/demo", "CI 测试店铺"],
  ]},
  { role: "viewer", pages: [
    ["/merchant/demo/devices", "店内资源"],
    ["/merchant/demo/live", "在店玩家"],
    ["/merchant/demo/players", "玩家"],
    ["/merchant/demo/pricing", "计费规则"],
    ["/merchant/demo/assets", "资产与兑换"],
    ["/merchant/demo/reports", "营业记录"],
  ]},
  { role: "owner", pages: [
    ["/cards", "卡片"], ["/merchant/demo/devices", "店内资源"],
    ["/merchant/demo/live", "在店玩家"], ["/merchant/demo/players", "玩家"],
    ["/merchant/demo/pricing", "计费规则"], ["/merchant/demo/assets", "资产与兑换"],
    ["/merchant/demo/reports", "营业记录"],
    ["/merchant/demo/settings", "店铺设置"],
    ["/merchant/demo/settings?group=billing", "店铺设置"],
    ["/merchant/demo/settings?group=players", "店铺设置"],
    ["/merchant/demo/settings?group=devices", "店铺设置"],
    ["/merchant/demo/settings?group=integrations", "店铺设置"],
    ["/merchant/demo/settings?group=data", "店铺设置"],
    ["/merchant/demo/settings?group=members", "店铺设置"],
  ]},
  { role: "admin", pages: [
    ["/admin", "管理"], ["/settings", "账号"], ["/merchant/demo/live", "在店玩家"],
  ]},
];

(async () => {
  const browser = await (browserEngine === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(browserEngine === "chromium" ? { args: ["--no-sandbox"] } : {}),
    ...(browserEngine === "chromium" && process.env.PRISM_CHROMIUM_PATH ? { executablePath: process.env.PRISM_CHROMIUM_PATH } : {}),
  });
  fs.mkdirSync(output, { recursive: true });
  const failures = [], coverage = [], allUnknown = [];
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      for (const testCase of cases) {
        const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
        await context.addInitScript(() => sessionStorage.setItem("prism.active-shop", "demo"));
        const page = await context.newPage();
        const unknown = [], mutations = [], exceptions = [];
        page.on("pageerror", error => exceptions.push(error.message));
        page.on("console", message => { if (message.type() === "error") exceptions.push(message.text()); });
        await page.route("**/api/**", async route => {
          const result = mock(route.request(), testCase.role, unknown, mutations);
          await route.fulfill({
            status: result === null ? 501 : 200,
            contentType: "application/json",
            body: JSON.stringify(result === null
              ? { error: { code: "UNMOCKED_API", message: "Unmocked API request" } }
              : { data: result }),
          });
        });
        for (const [url, heading] of testCase.pages) {
          const label = `${testCase.role} ${viewport.width}px ${url}`;
          try {
            const response = await page.goto(origin + url, { waitUntil: "domcontentloaded" });
            assert.equal(response.status(), 200);
            await page.getByRole("heading", { name: heading, exact: false }).first().waitFor({ timeout: 10000 });
            assert.equal(await page.locator("main").isVisible(), true);
            assert.equal(await page.locator("main").innerText().then(s => s.trim().length > 10), true);
            assert.equal(await page.getByText("页面暂时无法显示").count(), 0);
            if (url === "/settings") {
              // Empty mocks cannot detect when the account page receives a profile
              // DTO or fails to render real identity/passkey rows.
              await page.getByText("CI 绑定账号", { exact: true }).waitFor();
              await page.getByText("CI Passkey", { exact: true }).waitFor();
            }
            if (url.startsWith("/merchant/demo/") && testCase.role === "owner") {
              await page.getByRole("navigation", { name: "店家导航" })
                .getByRole("link", { name: "设置", exact: true }).waitFor({ state: "visible" });
            }
            if (url.startsWith("/merchant/demo/") && testCase.role === "viewer") {
              assert.strictEqual(await page.getByRole("navigation", { name: "店家导航" })
                .getByRole("link", { name: "设置", exact: true }).count(), 0);
            }
            if (url === "/merchant/demo/players") {
              // Keep both the funded and zero balance visible; undefined renders
              // an em dash, the regression caused by the server's lossy DTO.
              await page.getByText("125.95", { exact: true }).filter({ visible: true }).first().waitFor();
              await page.getByText("0.00", { exact: true }).filter({ visible: true }).first().waitFor();
              await page.getByText("零余额玩家", { exact: true }).filter({ visible: true }).first().waitFor();
            }
            if (url === "/merchant/demo/live") {
              await page.getByText(live.displayName, { exact: true }).first().waitFor();
              await page.getByRole("combobox", { name: "玩家分组" }).selectOption("status");
              await page.getByRole("combobox", { name: "玩家分组" }).selectOption("none");
              if (testCase.role === "owner" && viewport.width === 390) {
                await page.screenshot({ path: path.join(output, `on-site-mobile-${browserEngine}.png`), fullPage: true });
              }
            }
            if (url.endsWith("/devices")) {
              // Only capabilities some resource has get a chip; this shop has no resources.
              const chips = page.getByRole("group", { name: "资源类型" }).getByRole("button");
              assert.equal(await chips.count(), 1);
              await chips.first().click();
            }
            if (url.endsWith("/assets")) {
              const nav = page.getByRole("navigation", { name: "资产分类" });
              await nav.getByRole("button", { name: "优惠" }).click();
              await nav.getByRole("button", { name: "礼物" }).click();
              await nav.getByRole("button", { name: "兑换码" }).click();
            }
            // Both player tabs render one workspace: a list on the left and the
            // selected player's panel on the right. A viewer sees the panel but
            // gets no management actions, and there is no "add player" flow.
            if (url.endsWith("/live") || url.endsWith("/players")) {
              await page.getByRole("region", { name: "玩家资料" }).first().waitFor();
              assert.equal(await page.getByRole("button", { name: "添加玩家" }).count(), 0);
              if (testCase.role === "viewer") {
                for (const action of ["结账", "充值 / 扣款", "发放资产"]) {
                  assert.equal(
                    await page.getByRole("button", { name: action, exact: true }).count(),
                    0,
                  );
                }
              }
            }
            if (testCase.role === "owner" && url.endsWith("/pricing")) {
              await page.getByRole("button", { name: "添加规则" }).first().click();
              await page.getByRole("dialog").first().waitFor();
              await page.getByRole("dialog").first().getByRole("button", { name: "关闭" }).click();
              await page.getByRole("dialog").first().waitFor({ state: "hidden" });
            }
            if (testCase.role === "owner") {
              let open;
              if (url.endsWith("/devices")) open = "添加资源";
              if (open) {
                await page.getByRole("button", { name: open, exact: true }).first().click();
                await page.getByRole("dialog").first().waitFor();
                await page.getByRole("dialog").first().getByRole("button", { name: "关闭" }).click();
                await page.getByRole("dialog").first().waitFor({ state: "hidden" });
              }
            }
            coverage.push(label);
          } catch (error) {
            failures.push(`${label}: ${error.message}`);
            await page.screenshot({ path: path.join(output, `failed-${browserEngine}-${testCase.role}-${viewport.width}-${failures.length}.png`), fullPage: true }).catch(() => {});
          }
        }
        for (const value of new Set(unknown)) {
          allUnknown.push(value);
          failures.push(`${testCase.role} ${viewport.width}px: unmocked ${value}`);
        }
        if (exceptions.length) failures.push(`${testCase.role} ${viewport.width}px: ${exceptions.join(" | ")}`);
        console.log(`CHECK ${testCase.role} ${viewport.width}px: ${testCase.pages.length} routes; ${mutations.length} mocked writes`);
        await context.close();
      }
    }
    console.log(`${browserEngine} route matrix: ${coverage.length} passed, ${failures.length} failures; ${cases.reduce((n,c) => n+c.pages.length,0)*2} routes tested`);
    if (failures.length) throw new Error(failures.join("\n"));
    console.log("PASS role-based desktop/mobile navigation, on-site real player rendering and UI actions without external writes");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
