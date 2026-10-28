const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

/**
 * Rotating a token takes three confirmations, because it revokes the old value
 * at once and cannot be undone. This checks both rotating buttons (bot
 * credential and direct-connect device token) on the resource editor:
 *
 * - the first screen offers no submit button at all;
 * - each step must be cleared in order, and going back resets the ones after it;
 * - the cancel word has to be typed exactly;
 * - the PATCH carrying `rotateBotToken` / `rotateRelayToken` is sent only after
 *   the third step, never before.
 */
const origin = process.env.PRISM_SCAN_ORIGIN || "http://127.0.0.1:4173";
const shop = {
  id: "shop", publicId: "demo", name: "CI 测试店铺", timeZone: "Asia/Shanghai",
  latitude: 31.23, longitude: 121.47, radiusMeters: 80, billingEnabled: false,
  cashierEnabled: false, identityBindingRequired: false, locationEnabled: false,
};
const base = {
  coinAfterSwipe: false, hasHinata: false, kind: "machine", hinataUrl: null, homeAssistant: null,
  climate: null, ttlockLockId: null, coinKey: 32, mahjong: null, shopId: "shop",
  shopPublicId: "demo", aliases: [], enabled: true, hasBotToken: true, hasRelayToken: true,
  relayConnection: "embedded", relayUrl: "wss://relay.test/io", relayOnline: true, relayE2ee: false,
  bot: {
    playerCommands: "all", readOnlyNotice: "请扫码", staffCommands: true, powerOffStaffOnly: false,
    doorResourceId: null, receiptsToStaff: false, doorPasswordOnEntry: false,
    announceChannelIds: [], idleReminderMinutes: 5, announceIdle: false, announcePower: false,
    announceStarts: false, announceCards: false, announceCoins: false,
  },
};
const machines = [
  { ...base, id: "bot", publicId: "bot", name: "店铺 Bot" },
];
/** A bot that has never been issued a credential: nothing to revoke, so no three-step gate. */
const unissued = [{ ...base, id: "bot", publicId: "bot", name: "店铺 Bot", hasBotToken: false }];

const until = async (condition, what) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${what}`);
};

async function openEditor(botMachines = machines) {
  const browser = await chromium.launch();
  // The buttons under test are found by their Chinese copy, so ask for that locale.
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  const patches = [];
  const exceptions = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") exceptions.push(message.text()); });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (request.method() === "PATCH") {
      const body = JSON.parse(request.postData() || "null");
      patches.push({ path: p, body });
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ data: { machine: machines[0], botToken: "prism_integration_new", relayToken: "device-token-new" } }),
      });
    }
    if (request.method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' });
    let data = {};
    if (p === "/api/v1/me") data = { user: { id: "owner", username: "owner", displayName: "owner", role: "owner", hasShops: true } };
    else if (p === "/api/v1/merchant/shops") data = { shops: [shop] };
    else if (p === "/api/v1/merchant/machines") data = { machines: botMachines };
    else if (p === "/api/v1/merchant/resource-groups") data = { resourceGroups: [{ id: "default", name: "默认资源组", enabled: true, isDefault: true, defaultPricingConfigId: null, resourceCount: 0 }] };
    else if (p === "/api/v1/merchant/machines/occupancy") data = { resources: [] };
    else if (p === "/api/v1/merchant/machines/states") data = { states: {} };
    else if (p === "/api/v1/merchant/device-bindings") data = { bindings: [] };
    else if (p === "/api/v1/merchant/ha-connections") data = { connections: [] };
    // The bot editor reads the shop's TTLock connection; without it the page cannot render.
    else if (p === "/api/v1/shops/demo/staff/settings") data = { settings: { ttLockConnection: { accessToken: "ttlock-token" } } };
    else if (p === "/api/v1/shops/demo") data = { shop, membership: { playerId: "p", identityBound: true }, entryPricing: [] };
    else if (p === "/api/v1/shops/demo/staff/me") data = { staff: { id: "s", displayName: "店员", role: "owner", canWrite: true } };
    else if (p === "/api/v1/shops/demo/staff/live-players") data = { players: [], billingSnapshot: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
  });
  await page.goto(`${origin}/merchant/demo/resources`);
  await page.getByText("店铺 Bot", { exact: true }).first().waitFor();
  return { browser, page, patches, exceptions };
}

async function openResource(page, expect = "接入凭据") {
  // The resource row's own 编辑 button opens the editor; its side nav has one
  // entry per capability, and the bot is the last.
  // The card for this bot, not the group header's own 编辑.
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "店铺 Bot" }) });
  await card.getByRole("button", { name: "编辑" }).click();
  const nav = page.getByRole("navigation", { name: "资源设置" });
  await nav.waitFor();
  await nav.getByRole("button", { name: "店铺 Bot" }).click();
  await page.getByText(expect, { exact: false }).first().waitFor();
}

/** Opens the editor on the bot pane and walks the three steps; leaves the submit to the caller. */
async function walkThreeSteps(page, openLabel, confirmLabel, acceptLabel) {
  const open = page.getByRole("button", { name: openLabel });
  await open.waitFor();
  await open.click();
  await page.getByText("这一步不可撤销").waitFor();
  await page.getByRole("button", { name: "我明白，继续" }).click();
  await page.getByRole("checkbox", { name: acceptLabel }).check();
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByLabel("输入确认词").fill("轮换");
  await page.getByRole("button", { name: confirmLabel }).waitFor();
}

const ACCEPT = "我知道旧令牌取不回来，也知道该把它换到哪里。";

(async () => {
  // 1. The bot credential.
  {
    const { browser, page, patches, exceptions } = await openEditor();
    try {
      await openResource(page);

      // Step 0: one button, and pressing it submits nothing.
    const rotateBot = page.getByRole("button", { name: "轮换 Bot 凭据" });
    await rotateBot.waitFor();
    assert.equal(patches.length, 0, "no request before the confirmation is opened");

    await rotateBot.click();
    await page.getByText("这一步不可撤销").waitFor();
    assert.equal(patches.length, 0, "no request on the first step");
    // No submit button exists on this screen: the only way on is the plain button.
    assert.equal(await page.getByRole("button", { name: "确认轮换 Bot 凭据" }).count(), 0);

    await page.getByRole("button", { name: "我明白，继续" }).click();
    const accept = page.getByRole("checkbox", { name: "我知道旧令牌取不回来，也知道该把它换到哪里。" });
    await accept.waitFor();
    // Continue stays disabled until the consequence is accepted.
    assert.ok(await page.getByRole("button", { name: "继续" }).isDisabled());
    await accept.check();
    assert.equal(await page.getByRole("button", { name: "继续" }).isDisabled(), false);
    assert.equal(patches.length, 0, "no request on the second step");

    await page.getByRole("button", { name: "继续" }).click();
    const word = page.getByLabel("输入确认词");
    await word.waitFor();
    assert.equal(patches.length, 0, "no request on the third step yet");
    // A wrong word keeps the real button out of the page entirely.
    await word.fill("换轮");
    assert.equal(await page.getByRole("button", { name: "确认轮换 Bot 凭据" }).count(), 0);
    await word.fill("轮换");
    const confirm = page.getByRole("button", { name: "确认轮换 Bot 凭据" });
    await confirm.waitFor();
    assert.equal(patches.length, 0, "even the third screen sends nothing until pressed");

    await confirm.click();
    await until(() => patches.length > 0, "the rotation request");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].body.rotateBotToken, true, "the bot credential is what is rotated");

      assert.deepEqual(exceptions, []);
    } finally {
      await browser.close();
    }
  }

  // 2. The direct-connect device token, with no confirmation skipped.
  {
    const { browser, page, patches, exceptions } = await openEditor();
    try {
      const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "店铺 Bot" }) });
      await card.getByRole("button", { name: "编辑" }).click();
      const nav = page.getByRole("navigation", { name: "资源设置" });
      await nav.waitFor();
      await nav.getByRole("button", { name: "刷卡 · HINATA IO" }).click();
      await page.getByText("连接状态", { exact: false }).first().waitFor();
      assert.equal(patches.length, 0);
      assert.equal(await page.getByRole("button", { name: "确认轮换设备令牌" }).count(), 0);
      await walkThreeSteps(page, "轮换设备令牌", "确认轮换设备令牌", ACCEPT);
      await page.getByRole("button", { name: "确认轮换设备令牌" }).click();
      await until(() => patches.length > 0, "the device token rotation");
      assert.equal(patches.length, 1);
      assert.equal(patches[0].body.rotateRelayToken, true, "the device token is what is rotated");
      assert.deepEqual(exceptions, []);
    } finally {
      await browser.close();
    }
  }

  // 3. Nothing to revoke: issuing a first credential is one click, not three.
  {
    const { browser, page, patches, exceptions } = await openEditor(unissued);
    try {
      await openResource(page, "签发 Bot 凭据");
      assert.equal(await page.getByRole("button", { name: "轮换 Bot 凭据" }).count(), 0, "a bot with no credential has nothing to rotate");
      await page.getByRole("button", { name: "签发 Bot 凭据" }).click();
      await until(() => patches.length > 0, "the first issue");
      assert.equal(patches.length, 1);
      assert.equal(patches[0].body.rotateBotToken, true);
      assert.deepEqual(exceptions, []);
    } finally {
      await browser.close();
    }
  }

  console.log("rotate-token-check: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
