const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");

/**
 * The merchant device board. A live device (a HINATA IO listener subscribes to its Home Assistant)
 * is shown from what the shop hub sends over one WebSocket and is never read. A device with no state
 * of its own is read (from Home Assistant, there being nowhere else) once when the board opens and by
 * the refresh button, and after an action on it:
 * it is never "unknown", however old its value. Each device with power or an air conditioner has a
 * 实时 / 非实时 tag, and the one shop-level refresh only fills the devices with no state of their own.
 */
const origin = process.env.PRISM_SCAN_ORIGIN || "http://127.0.0.1:4173";
const output = process.env.PRISM_SCAN_OUTPUT || ".scan-check";
const shop = {
  id: "shop", publicId: "demo", name: "CI 测试店铺", timeZone: "Asia/Shanghai",
  latitude: 31.23, longitude: 121.47, radiusMeters: 80, billingEnabled: false,
  cashierEnabled: false, identityBindingRequired: false, locationEnabled: false,
};
const view = {
  mode: "cool", modes: ["off", "cool"], temperature: 24, currentTemperature: 27, minTemperature: 16,
  maxTemperature: 30, temperatureStep: 1, fanMode: "low", fanModes: ["auto", "low"],
};
const base = {
  coinAfterSwipe: false, hasHinata: false, kind: "machine", hinataUrl: null, homeAssistant: null, climate: null,
  ttlockLockId: null, coinKey: 32, mahjong: null, shopId: "shop", shopPublicId: "demo", aliases: [], enabled: true,
};
const machines = [
  { ...base, id: "cab", publicId: "cab", name: "机台A",
    homeAssistant: { connectionId: "ha_1", url: "https://ha.test", entityId: "switch.cab" },
    climate: { connectionId: "ha_1", url: "https://ha.test", entityId: "climate.room" } },
  { ...base, id: "io", publicId: "io", name: "机台B",
    homeAssistant: { connectionId: "ha_2", url: "https://ha2.test", entityId: "switch.io" } },
  { ...base, id: "door", publicId: "door", name: "大门", kind: "door", ttlockLockId: 7 },
];
const nothing = { watching: false, power: null, climate: null };

const until = async (condition, what) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${what}`);
};

/**
 * `watchedIo`: whether the second Home Assistant is watched too, so every device is.
 * `clock`: fake timers, to move past a reconnect wait and a polling interval.
 * `silentHub`: the hub accepts the connection and never says anything.
 * The hub is played by the page's WebSocket route: it greets each connection with the board's state,
 * and the test sends it whatever frames it wants to push. The "database" says the live machine is
 * off, which is older than what the test pushes; Home Assistant says the other one is on.
 */
async function openBoard(browser, { watchedIo, viewport, clock = false, silentHub = false }) {
  const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await context.addInitScript(() => sessionStorage.setItem("prism.active-shop", "demo"));
  const page = await context.newPage();
  if (clock) await page.clock.install();
  const exceptions = [], calls = [], sockets = [], received = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") exceptions.push(message.text()); });
  const snapshot = {
    cab: { watching: true, power: "off", climate: view },
    io: watchedIo ? { watching: true, power: "on", climate: null } : nothing,
  };
  await page.routeWebSocket(/\/api\/v1\/merchant\/machines\/ws/, (ws) => {
    sockets.push({ ws, url: ws.url() });
    ws.onMessage((message) => received.push(String(message)));
    if (!silentHub) ws.send(JSON.stringify({ type: "states", states: snapshot }));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (request.method() !== "GET") { calls.push(`${request.method()} ${p}`); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) }); }
    calls.push(p + url.search);
    let data = {};
    if (p === "/api/v1/me") data = { user: { id: "owner", username: "owner", displayName: "owner", role: "user", hasShops: true } };
    else if (p === "/api/v1/merchant/shops") data = { shops: [shop] };
    else if (p === "/api/v1/merchant/machines") data = { machines };
    else if (p === "/api/v1/merchant/machines/states") {
      data = { states: { ...snapshot, io: watchedIo ? snapshot.io : { ...nothing, power: "on" } } };
    }
    // One device, asked of Home Assistant after an action on it: it answers "off".
    else if (p === "/api/v1/merchant/machines/io/state") data = { watching: false, power: "off", climate: null };
    else if (p === "/api/v1/merchant/device-bindings") data = { bindings: [] };
    else if (p === "/api/v1/merchant/ha-connections") data = { connections: [] };
    else if (p === "/api/v1/shops/demo") data = { shop, membership: { playerId: "p", identityBound: true }, entryPricing: [] };
    else if (p === "/api/v1/shops/demo/staff/me") data = { staff: { id: "s", displayName: "店员", role: "owner", canWrite: true } };
    else if (p === "/api/v1/shops/demo/staff/live-players") data = { players: [], billingSnapshot: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
  });
  await page.goto(`${origin}/merchant/demo/devices`);
  await page.getByText("机台A", { exact: true }).waitFor();
  return { page, context, calls, exceptions, sockets, received };
}

const card = (page, name) => page.locator("article", { has: page.getByRole("heading", { name, exact: true }) });
const stateReads = (calls) => calls.filter((call) => call.startsWith("/api/v1/merchant/machines/states"));
const deviceReads = (calls, id) => calls.filter((call) => call.startsWith(`/api/v1/merchant/machines/${id}/state`));
const push = (board, frame) => board.sockets[0].ws.send(JSON.stringify(frame));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ASK = "/api/v1/merchant/machines/states?shopId=shop";

/** Open a device's operate panel and press one of its buttons. */
async function operate(page, name, button) {
  await card(page, name).getByRole("button", { name: "操作", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: button, exact: true }).click();
  return dialog;
}

(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      const label = viewport.width < 600 ? "mobile" : "desktop";

      // One device is live and one has no state of its own.
      const mixed = await openBoard(browser, { watchedIo: false, viewport });
      const { page, calls } = mixed;
      const cab = card(page, "机台A"), io = card(page, "机台B"), door = card(page, "大门");
      await cab.getByText("实时", { exact: true }).waitFor();
      assert.equal(await cab.getByText("已关机").count(), 1, "A live device shows what the hub sent");
      assert.equal(await cab.getByText(/空调：/).count(), 1);
      assert.equal(await door.getByText(/实时/).count(), 0, "A device without power or air conditioner has no tag");
      assert.equal(await card(page, "机台B").getByText("非实时", { exact: true }).count(), 1);
      assert.equal(deviceReads(calls, "cab").length + deviceReads(calls, "io").length, 0, "No request per card");
      const refresh = page.getByRole("button", { name: "刷新设备状态" });
      assert.equal(await refresh.count(), 1, "One refresh for the shop, not one per card");

      // The device with no state of its own is read once as the board opens, and is never unknown.
      await io.getByText("已开机").waitFor();
      assert.equal(await page.getByText("电源状态未知").count(), 0, "A device with no state of its own always has a value");
      assert.deepEqual(stateReads(calls), [ASK], "Only the device with no state of its own is asked, once");
      await page.screenshot({ path: `${output}/device-board-${label}.png`, fullPage: true });

      // One connection for the whole board, opened for the shop.
      await until(() => mixed.sockets.length === 1, "the board's WebSocket");
      assert.equal(new URL(mixed.sockets[0].url).searchParams.get("shopId"), "shop");

      // The hub pushes a live device's change: it shows at once, with no read.
      push(mixed, { type: "state", deviceId: "cab", power: "on" });
      await cab.getByText("已开机").waitFor();
      push(mixed, { type: "state", deviceId: "cab", climate: { ...view, currentTemperature: 29 } });
      await cab.getByText(/室温 29°/).waitFor();
      assert.equal(stateReads(calls).length, 1, "Pushed changes are not read");

      // Operating a live device reads nothing at all, not the shop and not the device: the change
      // arrives on its own. The panel shows what the board has.
      let dialog = await operate(page, "机台A", "开机");
      await until(() => calls.includes("POST /api/v1/merchant/machines/cab/actions"), "the action");
      await until(() => calls.filter((call) => call.startsWith("/api/v1/merchant/machines?")).length >= 2, "the device list reloading");
      await pause(300);
      assert.equal(await dialog.getByText("已开机").count() > 0, true, "The panel shows the pushed state");
      assert.equal(stateReads(calls).length, 1, "An action on a live device does not read the shop");
      assert.equal(deviceReads(calls, "cab").length, 0, "An action on a live device does not read the device");
      await dialog.getByRole("button", { name: "关闭" }).click();

      // Operating a device with no state of its own reads that one device once, since nothing
      // else will say what the action did. Until then the old value stays; it is never unknown.
      dialog = await operate(page, "机台B", "开机");
      await until(() => deviceReads(calls, "io").length === 1, "the device being read after the action");
      assert.deepEqual(deviceReads(calls, "io"), ["/api/v1/merchant/machines/io/state"]);
      await io.getByText("已关机").waitFor();
      assert.equal(await io.getByText("非实时", { exact: true }).count(), 1);
      assert.equal(await page.getByText("电源状态未知").count(), 0);
      assert.equal(stateReads(calls).length, 1, "Reading one device is not reading the shop");
      await dialog.getByRole("button", { name: "关闭" }).click();

      // Refreshing asks for the devices with no state of their own and fills them in. It does not
      // make them live and leaves the live one alone, though the database still says "off" there.
      await refresh.click();
      await io.getByText("已开机").waitFor();
      assert.equal(await io.getByText("非实时", { exact: true }).count(), 1);
      assert.equal(await cab.getByText("实时", { exact: true }).count(), 1);
      assert.equal(await cab.getByText("已开机").count(), 1, "A refresh does not touch a live device");
      assert.deepEqual(stateReads(calls), [ASK, ASK], "The refresh is the second ask, not a read of the live device");
      assert.equal(await refresh.isEnabled(), true, "A device with no state of its own remains to refresh");
      await page.screenshot({ path: `${output}/device-board-refreshed-${label}.png`, fullPage: true });

      // Which devices are live changes: the hub sends the whole board again. What a device last showed
      // stays; only its tag changes.
      push(mixed, { type: "states", states: {
        cab: nothing,
        io: { watching: true, power: "off", climate: null },
      } });
      await cab.getByText("非实时", { exact: true }).waitFor();
      await io.getByText("实时", { exact: true }).waitFor();
      assert.equal(await cab.getByText("已开机").count(), 1, "A device that stopped being live keeps its last value");
      assert.equal(await page.getByText("电源状态未知").count(), 0);
      assert.equal(await io.getByText("已关机").count(), 1);
      await page.screenshot({ path: `${output}/device-board-switched-${label}.png`, fullPage: true });
      assert.deepEqual(mixed.exceptions, []);
      await mixed.context.close();

      // Every device is live: nothing to refresh and nothing to ask.
      const watched = await openBoard(browser, { watchedIo: true, viewport });
      await card(watched.page, "机台B").getByText("实时", { exact: true }).waitFor();
      assert.equal(await card(watched.page, "机台B").getByText("非实时").count(), 0);
      const idle = watched.page.getByRole("button", { name: "刷新设备状态" });
      assert.equal(await idle.isDisabled(), true);
      assert.equal(await idle.getAttribute("title"), "所有设备都在实时监听");
      await pause(300);
      assert.deepEqual(stateReads(watched.calls), [], "Nothing is read when every device is live");
      assert.deepEqual(watched.exceptions, []);
      await watched.context.close();

      console.log(`PASS ${label}: live devices only from the hub, devices with no state of their own read once and never unknown, one read after an action on them, refresh only fills them`);
    }

    // The hub says nothing: after a moment the board reads the shop over HTTP, once, asking for the
    // devices with no state of their own too.
    const silent = await openBoard(browser, { watchedIo: false, viewport: { width: 1280, height: 900 }, clock: true, silentHub: true });
    await until(() => silent.sockets.length === 1, "the board's WebSocket");
    assert.deepEqual(stateReads(silent.calls), []);
    await silent.page.clock.fastForward(4_000);
    await until(() => stateReads(silent.calls).length === 1, "the fallback read");
    assert.deepEqual(stateReads(silent.calls), [ASK]);
    await card(silent.page, "机台A").getByText("实时", { exact: true }).waitFor();
    await card(silent.page, "机台B").getByText("非实时", { exact: true }).waitFor();
    await card(silent.page, "机台B").getByText("已开机").waitFor();
    assert.deepEqual(silent.exceptions, []);
    await silent.context.close();
    console.log("PASS a silent hub: one HTTP read as the fallback");

    // The connection drops: nothing is read meanwhile, and the board reconnects. The hub sends the whole
    // shop again, which is how a live device catches up on what it missed.
    const dropped = await openBoard(browser, { watchedIo: false, viewport: { width: 1280, height: 900 }, clock: true });
    await until(() => dropped.sockets.length === 1, "the board's WebSocket");
    await card(dropped.page, "机台B").getByText("已开机").waitFor();
    const reads = stateReads(dropped.calls).length;
    // A keep-alive goes out while it is open.
    await dropped.page.clock.fastForward(31_000);
    await until(() => dropped.received.includes("ping"), "a keep-alive");
    dropped.sockets[0].ws.close();
    await dropped.page.clock.fastForward(16_000);
    await until(() => dropped.sockets.length === 2, "the board reconnecting");
    await pause(300);
    assert.equal(stateReads(dropped.calls).length, reads, "A live device is never read, not even while the connection is down");
    // What the hub says when it is back shows.
    dropped.sockets[1].ws.send(JSON.stringify({ type: "states", states: { cab: { watching: true, power: "on", climate: view }, io: nothing } }));
    await card(dropped.page, "机台A").getByText("已开机").waitFor();
    assert.deepEqual(dropped.exceptions, []);
    await dropped.context.close();
    console.log("PASS keep-alive, reconnect after a drop, and the hub's resend catching a live device up without any read");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
