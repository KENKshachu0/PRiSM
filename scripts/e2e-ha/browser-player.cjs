/**
 * The page a player reaches by scanning a machine's QR code, in a real browser against the real
 * platform, Home Assistant and IO client (see browser-board.cjs). Two modes:
 *
 *   休息室  no IO watches its Home Assistant: nothing is stored, the page asks once, after the
 *           machine's name is on screen, and Home Assistant answering a power-on is the end of it.
 *   机台A   a HINATA IO watches: the state arrives with the page and every change is pushed over
 *           the page's WebSocket; the page never asks Home Assistant anything.
 *
 *   PRISM_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e-ha/browser-player.cjs
 */
const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

process.chdir(path.resolve(__dirname, "../.."));
const cfg = JSON.parse(fs.readFileSync(".e2e/platform.json", "utf8"));
const { shop, player, ha, devices } = cfg;
const BASE = "http://localhost:8787";
const output = process.env.PRISM_SCAN_OUTPUT || ".e2e/shots";
const IO_BIN = process.env.IO_SIM || "/Users/neri/Projects/hinata-aimeio-rs/tools/mac-test/target/debug/io_sim";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await pause(40);
  }
  assert.fail(`Timed out waiting for ${what}`);
}
let steps = 0;
const step = (message) => console.log(`  ok    ${message}`) || (steps += 1);

const haHeaders = { authorization: `Bearer ${ha.adminToken}`, "content-type": "application/json" };
const haCall = (domain, service, data) => fetch(`${ha.url}/api/services/${domain}/${service}`, { method: "POST", headers: haHeaders, body: JSON.stringify(data) });
const haState = async (id) => (await fetch(`${ha.url}/api/states/${id}`, { headers: haHeaders })).json();
function platformReads(since) {
  const out = spawnSync("docker", ["logs", "--since", since, "prism-e2e-ha"], { encoding: "utf8" });
  const reads = [];
  for (const line of `${out.stdout}\n${out.stderr}`.split("\n")) {
    const m = line.match(/\[aiohttp\.access\] \S+ \[[^\]]*\] "GET \/api\/states\/(\S+) HTTP\/[\d.]+" \d+ \d+ "[^"]*" "([^"]*)"/);
    if (m && !/^(Bun|curl|node|undici)(\/|$)/i.test(m[2])) reads.push(m[1]);
  }
  return reads.sort();
}
async function resetHa() {
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  await haCall("switch", "turn_off", { entity_id: "switch.ac" });
  await haCall("input_boolean", "turn_off", { entity_id: "input_boolean.lounge_power" });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.hvac", hvac_mode: "cool" });
  await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 21 });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.heatpump", hvac_mode: "heat" });
  await haCall("climate", "set_temperature", { entity_id: "climate.heatpump", temperature: 20 });
}
const noneLive = () => spawnSync("scripts/e2e-ha/d1.sh", ["SELECT count(*) AS n FROM ha_event_connections"], { encoding: "utf8" }).stdout.includes('"n": 0');
const isLive = () => !noneLive();
let io = null;
function startIo() {
  const fd = fs.openSync(".e2e/io/a.log", "w");
  io = spawn(IO_BIN, [], { cwd: ".e2e/io", env: { ...process.env, SEGATOOLS_CONFIG_PATH: path.resolve(".e2e/io/a.ini"), RUST_LOG: "hinata_mac_test=debug" }, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
}
async function stopIo() {
  spawnSync("pkill", ["-x", "io_sim"]);
  io?.kill("SIGKILL");
  await pause(400);
}

/** A player's page, with everything it sends recorded. */
async function scan(browser, device, { delayDevice = 0 } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  await context.addCookies([{ name: "arcadelink_session", value: player.token, url: BASE }]);
  const page = await context.newPage();
  const seen = { requests: [], frames: [], sockets: 0, exceptions: [] };
  page.on("pageerror", (error) => seen.exceptions.push(error.message));
  page.on("console", (message) => message.type() === "error" && seen.exceptions.push(message.text()));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) seen.requests.push({ at: Date.now(), method: request.method(), path: url.pathname, body: request.postData() });
  });
  page.on("websocket", (ws) => {
    seen.sockets += 1;
    ws.on("framereceived", ({ payload }) => seen.frames.push({ at: Date.now(), frame: JSON.parse(String(payload)) }));
  });
  if (delayDevice) await page.route("**/api/v1/devices/session/device*", async (route) => { await pause(delayDevice); await route.continue(); });
  const started = Date.now();
  await page.goto(`${BASE}/t/${shop.publicId}/${devices[device].publicId}`);
  return { page, context, seen, started };
}
const calls = (seen, p) => seen.requests.filter((r) => r.path === p);
const text = (page) => page.locator("body").innerText();

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PRISM_CHROMIUM_PATH ? { executablePath: process.env.PRISM_CHROMIUM_PATH } : {}) });
  fs.mkdirSync(output, { recursive: true });
  try {
    await stopIo();
    await resetHa();
    await until(noneLive, "nothing live", 20000);
    await pause(500);

    console.log("\n== 休息室：没有 IO 监听（无状态）");
    {
      const since = new Date().toISOString();
      const { page, seen, context, started } = await scan(browser, "lounge", { delayDevice: 1500 });
      await page.getByText("休息室").first().waitFor();
      const named = Date.now() - started;
      await page.getByText("正在获取电源状态").waitFor({ timeout: 1000 });
      assert.equal(calls(seen, "/api/v1/devices/session/device").length, 1, "the one read is in flight");
      assert.equal(await page.getByText("设备尚未开机").count(), 0, "no power answer yet");
      step(`设备名先出现（${named} ms），副标题显示「正在获取电源状态」，此时那次读取还在途中`);
      await page.screenshot({ path: `${output}/player-lounge-checking.png` });
      await page.getByText("设备尚未开机").waitFor({ timeout: 5000 });
      assert.equal(await page.getByText("正在获取电源状态").count(), 0);
      step("读取返回后「正在获取电源状态」消失，显示「设备尚未开机」");
      await pause(400);
      assert.equal(seen.sockets, 0, "no WebSocket for a device nothing watches");
      assert.equal(calls(seen, "/api/v1/devices/session/device").length, 1);
      assert.deepEqual(platformReads(since), ["climate.heatpump", "input_boolean.lounge_power"]);
      step("整个页面只读了 1 次 /session/device、没有开 WebSocket；HA 只收到休息室两个实体各 1 次读取");

      // Home Assistant answering a power-on is the end of it: no read-back, the page moves on.
      const t0 = new Date().toISOString();
      const before = seen.requests.length;
      await page.getByRole("button", { name: "开机", exact: true }).click();
      await page.getByText("设备尚未开机").waitFor({ state: "detached", timeout: 8000 });
      await pause(700);
      assert.equal((await haState("input_boolean.lounge_power")).state, "on");
      const after = seen.requests.slice(before);
      assert.equal(after.filter((r) => r.path === "/api/v1/devices/session/actions").length, 1);
      assert.equal(calls(seen, "/api/v1/devices/session/device").length, 1, "no read after power-on");
      assert.deepEqual(platformReads(t0), [], "Home Assistant was not asked to confirm");
      step("点「开机」：HA 真的打开了；HA 回 200 页面就继续，没有回读、HA 没收到任何读取");
      await page.screenshot({ path: `${output}/player-lounge-on.png` });

      // The temperature buttons settle for a second, then send once.
      const target = (await haState("climate.heatpump")).attributes.temperature;
      const up = page.getByRole("button", { name: "调高温度" }).first();
      const clickedAt = [];
      for (let i = 0; i < 3; i += 1) { await up.click(); clickedAt.push(Date.now()); await pause(120); }
      const lastClick = clickedAt[clickedAt.length - 1];
      await pause(700);
      assert.equal(seen.requests.filter((r) => r.method === "POST" && /set_temperature/.test(r.body || "")).length, 0, "nothing sent while the button is still being pressed");
      await until(() => seen.requests.some((r) => r.method === "POST" && /set_temperature/.test(r.body || "")), "the temperature request", 4000);
      const sent = seen.requests.filter((r) => r.method === "POST" && /set_temperature/.test(r.body || ""));
      assert.equal(sent.length, 1, "three presses, one request");
      // The entity declares no step, so each press moves the setting by the page's default of 0.5°.
      const STEP = 0.5;
      const expected = target + 3 * STEP;
      assert.equal(JSON.parse(sent[0].body).temperature, expected);
      const waited = sent[0].at - lastClick;
      assert.ok(waited >= 900 && waited < 1800, `sent ${waited} ms after the last press`);
      await until(async () => (await haState("climate.heatpump")).attributes.temperature === expected, "Home Assistant's temperature", 5000);
      step(`调温连按 3 次：松手 ${waited} ms 后只发 1 个请求（${target}° → ${expected}°），HA 的温度确实变了`);
      assert.deepEqual(seen.exceptions, []);
      await context.close();
    }

    console.log("\n== 机台A：IO 在监听（事件驱动）");
    {
      await resetHa();
      await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
      startIo();
      await until(isLive, "the connection to go live", 25000);
      await pause(800);
      const since = new Date().toISOString();
      const { page, seen, context } = await scan(browser, "a");
      await page.getByText("设备尚未开机").waitFor({ timeout: 8000 });
      await until(() => seen.frames.some((f) => f.frame.type === "hello"), "the hub's greeting");
      const hello = seen.frames.find((f) => f.frame.type === "hello").frame;
      assert.equal(hello.watching, true);
      assert.equal(hello.power, "off");
      assert.equal(hello.climate.temperature, 21);
      assert.equal(calls(seen, "/api/v1/devices/session/device").length, 0, "a watched device is never asked");
      assert.equal(seen.sockets, 1);
      step("扫码：hub 的第一条帧就带着 watching=true 和当前电源/空调；页面没发 /session/device，只开 1 条 WebSocket");
      await page.screenshot({ path: `${output}/player-a-live.png` });

      // Power on: Home Assistant is asked to switch, and the page moves on when the push says it is on.
      const before = seen.requests.length;
      const framesBefore = seen.frames.length;
      await page.getByRole("button", { name: "开机", exact: true }).click();
      await page.getByText("设备尚未开机").waitFor({ state: "detached", timeout: 8000 });
      assert.equal((await haState("switch.decorative_lights")).state, "on");
      assert.ok(seen.frames.slice(framesBefore).some((f) => f.frame.type === "state" && f.frame.power === "on"), "the page moved on because of the pushed state");
      assert.equal(calls(seen, "/api/v1/devices/session/device").length, 0);
      step("点「开机」：页面是在收到推送（power=on）后才往下走的，没有任何读取");

      // The machine is switched off elsewhere: the page notices by itself and goes back to the power page.
      const quiet = seen.requests.length;
      await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
      await page.getByText("设备尚未开机").waitFor({ timeout: 4000 });
      assert.equal(seen.requests.length, quiet, "going back to the power page needed no request");
      step("HA 里把机台关掉：页面自己回到「设备尚未开机」，没有发请求");
      await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
      await page.getByText("设备尚未开机").waitFor({ state: "detached", timeout: 4000 });
      await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 25 });
      await page.getByText("25°").first().waitFor({ timeout: 4000 });
      step("HA 里把空调设成 25°：页面立刻显示 25°，没有发请求");
      assert.deepEqual(platformReads(since), [], "Home Assistant was never asked by the platform");
      step("整个过程 HA 的访问日志里平台没有任何一次读取");

      // The IO goes away: the device is no longer watched, so the page asks once, like any other.
      const t1 = new Date().toISOString();
      const asked = calls(seen, "/api/v1/devices/session/device").length;
      await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 27 });
      await page.getByText("27°").first().waitFor({ timeout: 4000 });
      await stopIo();
      await until(() => seen.frames.some((f) => f.frame.type === "watching" && f.frame.watching === false), "the hub to say the device is no longer watched", 8000);
      await until(() => calls(seen, "/api/v1/devices/session/device").length === asked + 1, "the page's one read", 8000);
      await pause(600);
      assert.equal(calls(seen, "/api/v1/devices/session/device").length, asked + 1, "exactly one read");
      assert.deepEqual(platformReads(t1), ["climate.hvac", "switch.decorative_lights"]);
      step("IO 掉线：hub 告知「不再监听」，页面只读 1 次（HA 收到 A 的电源和空调各 1 次）");
      assert.equal(await page.getByText("27°").count() > 0, true, "the last value stays");

      // It comes back: the hub says so, sends the state, and the page stops asking.
      const t2 = new Date().toISOString();
      const frames = seen.frames.length;
      startIo();
      await until(() => seen.frames.slice(frames).some((f) => f.frame.type === "watching" && f.frame.watching === true), "the device to be watched again", 25000);
      const back = seen.frames.slice(frames).find((f) => f.frame.type === "watching" && f.frame.watching === true).frame;
      assert.equal(back.power, "on");
      await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 22 });
      await page.getByText("22°").first().waitFor({ timeout: 4000 });
      assert.equal(calls(seen, "/api/v1/devices/session/device").length, asked + 1, "no further reads");
      assert.deepEqual(platformReads(t2), []);
      step("IO 回来：hub 再次告知「监听中」并带上当前状态，之后又靠推送更新，不再读");
      assert.deepEqual(seen.exceptions, []);
      step("页面没有报错、控制台没有 error");
      await context.close();
    }
  } finally {
    await stopIo();
    await browser.close();
  }
  console.log(`\n${steps} browser checks passed`);
})().catch((error) => {
  console.error(error);
  spawnSync("pkill", ["-x", "io_sim"]);
  process.exit(1);
});
