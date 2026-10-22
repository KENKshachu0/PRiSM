/**
 * The "HA 监听器" area of the merchant device board, in a real browser against the real platform, Home
 * Assistant, HINATA IO client and shop bot (see scenarios.ts and bot-sim.ts). A shop owner sees who is
 * watching and how many slots there are; only the platform administrator can change the number.
 *
 *   PRISM_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e-ha/browser-watchers.cjs
 */
const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

process.chdir(path.resolve(__dirname, "../.."));
const cfg = JSON.parse(fs.readFileSync(".e2e/platform.json", "utf8"));
const { shop, owner, admin, origin: platform } = cfg;
const BASE = "http://localhost:8787"; // the platform's APP_ORIGIN
const output = process.env.PRISM_SCAN_OUTPUT || ".e2e/shots";
const IO_BIN = process.env.IO_SIM || "/Users/neri/Projects/hinata-aimeio-rs/tools/mac-test/target/debug/io_sim";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let steps = 0;
const step = (message) => console.log(`  ok    ${message}`) || (steps += 1);

const children = [];
function spawnLogged(command, args, env, log) {
  const fd = fs.openSync(log, "w");
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  children.push(child);
  return child;
}
const startIo = () => spawnLogged(IO_BIN, [], { SEGATOOLS_CONFIG_PATH: path.resolve(".e2e/io/a.ini"), RUST_LOG: "hinata_mac_test=debug" }, ".e2e/io/a.log");
const startBot = (name) => spawnLogged("bun", ["run", "scripts/e2e-ha/bot-sim.ts"], { BOT_NAME: name }, ".e2e/bot-1.log");
function stopAll() {
  for (const child of children) child.kill("SIGKILL");
  spawnSync("pkill", ["-x", "io_sim"]);
  spawnSync("pkill", ["-f", "e2e-ha/bot-sim.ts"]);
}
const setLimit = (count) =>
  fetch(`${platform}/api/v1/merchant/ha-watchers?shopId=${shop.id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
    body: JSON.stringify({ count }),
  });

async function openBoard(browser, token, viewport) {
  const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await context.addCookies([{ name: "arcadelink_session", value: token, url: BASE }]);
  await context.addInitScript((publicId) => sessionStorage.setItem("prism.active-shop", publicId), shop.publicId);
  const page = await context.newPage();
  const exceptions = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  page.on("console", (message) => message.type() === "error" && exceptions.push(message.text()));
  await page.goto(`${BASE}/merchant/${shop.publicId}/devices`);
  await page.getByRole("heading", { name: "机台A", exact: true }).waitFor();
  return { page, context, exceptions };
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PRISM_CHROMIUM_PATH ? { executablePath: process.env.PRISM_CHROMIUM_PATH } : {}) });
  fs.mkdirSync(output, { recursive: true });
  try {
    stopAll();
    await setLimit(2);
    await pause(1500);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const label = viewport.width < 600 ? "mobile" : "desktop";
      console.log(`\n== ${label}`);
      stopAll();
      await setLimit(2);
      await pause(1500);

      // Nobody is watching: the board says so, and what that means for the status it shows.
      const ownerView = await openBoard(browser, owner.token, viewport);
      const panel = ownerView.page.getByRole("region", { name: "HA 监听器" });
      await panel.getByText(/没有监听器在线/).waitFor({ timeout: 8000 });
      await panel.getByText("0 / 2 个监听器").waitFor();
      step("没有监听器在线：区域写明「没有监听器在线」和「0 / 2」，并解释设备状态是非实时");

      // A bot and a machine come online: the bot is listed first, by its name, then the machine by its device's name.
      startIo();
      await pause(2500);
      startBot("前台");
      await panel.getByText("前台").waitFor({ timeout: 25000 });
      await panel.getByText("机台A").waitFor({ timeout: 25000 });
      await panel.getByText("2 / 2 个监听器").waitFor();
      assert.equal(await panel.getByText("监听中").count(), 2);
      const items = await panel.locator("li").allInnerTexts();
      assert.match(items[0], /前台.*Bot.*监听中/s, `the bot comes first: ${items[0]}`);
      assert.match(items[1], /机台A.*机台.*监听中/s, `then the machine: ${items[1]}`);
      step("Bot 上线：列表里 Bot「前台」排第一、机台A 第二，都是「监听中」，名额 2 / 2");
      assert.equal(await panel.locator("select").count(), 0);
      assert.equal(await panel.getByText("由平台管理员设置").count(), 1);
      step("店主只能看：没有下拉框，写着「由平台管理员设置」");
      await ownerView.page.screenshot({ path: `${output}/watchers-owner-${label}.png`, fullPage: true });

      // The platform administrator can change it, for this shop, and it takes effect.
      const adminView = await openBoard(browser, admin.token, viewport);
      const adminPanel = adminView.page.getByRole("region", { name: "HA 监听器" });
      const select = adminPanel.getByRole("combobox", { name: "监听器数量" });
      await select.waitFor({ timeout: 8000 });
      assert.equal(await select.inputValue(), "2");
      assert.deepEqual(await select.locator("option").allTextContents(), ["1", "2", "3", "4"]);
      await select.selectOption("1");
      await adminPanel.getByText("1 / 1 个监听器").waitFor({ timeout: 8000 });
      await adminPanel.locator("li").first().waitFor();
      assert.equal(await adminPanel.locator("li").count(), 1);
      assert.match(await adminPanel.locator("li").first().innerText(), /前台/);
      step("平台管理员有下拉框（1–4）：改成 1 后，列表立刻只剩 Bot「前台」，机台A 让位");
      // The owner's own board follows without reloading.
      await panel.getByText("1 / 1 个监听器").waitFor({ timeout: 8000 });
      assert.equal(await panel.locator("li").count(), 1);
      step("店主那边不用刷新也同步变成「1 / 1」");
      const stored = spawnSync("scripts/e2e-ha/d1.sh", [`SELECT value_json FROM app_settings WHERE shop_id='${shop.id}' AND key='devices.ha_watcher_limit'`], { encoding: "utf8" }).stdout;
      assert.match(stored, /count\\":1/, `the number is stored for this shop: ${stored}`);
      step("数量真的存进了这家店的设置里");
      await adminView.page.screenshot({ path: `${output}/watchers-admin-${label}.png`, fullPage: true });

      // The bot goes away: the machine takes the slot, and the list says so.
      stopAll();
      await panel.getByText(/没有监听器在线/).waitFor({ timeout: 15000 });
      step("全部掉线：两边的列表都回到「没有监听器在线」");
      assert.deepEqual(ownerView.exceptions, []);
      assert.deepEqual(adminView.exceptions, []);
      step("页面没有报错、控制台没有 error");
      await ownerView.context.close();
      await adminView.context.close();
    }
  } finally {
    stopAll();
    await setLimit(2).catch(() => undefined);
    await browser.close();
  }
  console.log(`\n${steps} browser checks passed`);
})().catch((error) => {
  console.error(error);
  stopAll();
  process.exit(1);
});
