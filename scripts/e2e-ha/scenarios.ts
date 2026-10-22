/**
 * End-to-end scenarios against the real thing: Home Assistant in docker, the platform under `wrangler dev`,
 * and the real firmware watcher (hinata-aimeio-rs `remote.rs` / `ha.rs`) compiled for macOS as `io_sim`.
 *
 *   bun run scripts/e2e-ha/scenarios.ts [scenario ...]
 *
 * Needs `.e2e/ha.json` (ha-onboard.ts) and `.e2e/platform.json` (seed.ts). Every assertion is made on what
 * the real components did: the frames the board WebSocket received, rows in D1, and the requests Home
 * Assistant's own access log recorded.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { decryptSecret } from "../../packages/server/src/crypto.ts";

const root = resolve(import.meta.dir, "../..");
process.chdir(root);
const cfg = JSON.parse(readFileSync(".e2e/platform.json", "utf8"));
const { origin, shop, owner, admin, ha, devices } = cfg as {
  origin: string;
  shop: { id: string };
  owner: { token: string };
  admin: { token: string };
  ha: { url: string; adminToken: string };
  devices: Record<"a" | "b" | "lounge", { id: string; relayToken?: string }>;
};
const IO_BIN = process.env.IO_SIM ?? "/Users/neri/Projects/hinata-aimeio-rs/tools/mac-test/target/debug/io_sim";
const LEASE_MS = 90_000;

// ---------------------------------------------------------------- reporting

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): boolean {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    const line = `${name}${detail === undefined ? "" : ` -- ${JSON.stringify(detail)}`}`;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
  return ok;
}
const info = (message: string) => console.log(`        ${message}`);
const section = (title: string) => console.log(`\n== ${title}`);

// ---------------------------------------------------------------- Home Assistant

const haHeaders = { authorization: `Bearer ${ha.adminToken}`, "content-type": "application/json" };
async function haCall(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${ha.url}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: haHeaders,
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`${domain}.${service} ${response.status}`);
}
async function haState(entityId: string): Promise<{ state: string; attributes: Record<string, any>; last_updated: string }> {
  // Right after a restart Home Assistant answers before its entities exist; wait for this one.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${ha.url}/api/states/${entityId}`, { headers: haHeaders }).catch(() => null);
    if (response?.ok) return response.json() as never;
    await Bun.sleep(500);
  }
  throw new Error(`Home Assistant has no ${entityId}`);
}

/** Requests Home Assistant served to anything but this script, from its own access log. */
type HaRequest = { method: string; path: string; ua: string };
function haRequests(since: string): HaRequest[] {
  const out = spawnSync("docker", ["logs", "--since", since, "prism-e2e-ha"], { encoding: "utf8" });
  const requests: HaRequest[] = [];
  for (const line of `${out.stdout}\n${out.stderr}`.split("\n")) {
    const match = line.match(/\[aiohttp\.access\] \S+ \[[^\]]*\] "(\w+) (\S+) HTTP\/[\d.]+" \d+ \d+ "[^"]*" "([^"]*)"/);
    if (match && !/^(Bun|curl)\//.test(match[3]!)) requests.push({ method: match[1]!, path: match[2]!, ua: match[3]! });
  }
  return requests;
}
/** The state entities the platform read over REST since `since`. */
const platformReads = (since: string) =>
  haRequests(since).filter((request) => request.method === "GET" && request.path.startsWith("/api/states")).map((request) => request.path.replace("/api/states/", ""));

async function resetHa(): Promise<void> {
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  await haCall("switch", "turn_off", { entity_id: "switch.ac" });
  await haCall("input_boolean", "turn_off", { entity_id: "input_boolean.lounge_power" });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.hvac", hvac_mode: "cool" });
  await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 21 });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.heatpump", hvac_mode: "heat" });
  await haCall("climate", "set_temperature", { entity_id: "climate.heatpump", temperature: 20 });
}

// ---------------------------------------------------------------- platform

const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
async function api(path: string, init: RequestInit & { as?: string } = {}): Promise<{ status: number; body: any }> {
  const { as, ...rest } = init;
  const response = await fetch(`${origin}${path}`, {
    ...rest,
    headers: { ...headers, ...(as ? { authorization: `Bearer ${as}` } : {}), ...(rest.headers as object) },
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body?.data ?? body };
}
type Facts = { watching: boolean; power: string | null; climate: any };
async function boardStates(): Promise<Record<string, Facts>> {
  return (await api(`/api/v1/merchant/machines/states?shopId=${shop.id}`)).body.states;
}
const act = (device: keyof typeof devices, action: string, extra: object = {}) =>
  api(`/api/v1/merchant/machines/${devices[device].id}/actions`, {
    method: "POST",
    body: JSON.stringify({ operationId: crypto.randomUUID(), action, ...extra }),
  });

function d1(): Database {
  const dir = ".e2e/state/v3/d1/miniflare-D1DatabaseObject";
  const file = readdirSync(dir).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")!;
  // Not opened read-only: a WAL database whose -shm file was just removed cannot be opened that way.
  const db = new Database(`${dir}/${file}`);
  db.run("PRAGMA query_only=1");
  return db;
}
const liveConnections = () =>
  (d1().query("SELECT connection_id FROM ha_event_connections WHERE shop_id=?").all(shop.id) as { connection_id: string }[]).map((row) => row.connection_id);
const eventCount = (deviceId: string, capability: string) =>
  (d1().query("SELECT count(*) AS n FROM device_events WHERE device_id=? AND capability=?").get(deviceId, capability) as { n: number }).n;
async function until<T>(what: string, produce: () => T | Promise<T>, ms = 15_000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await produce();
    if (value) return value;
    await Bun.sleep(100);
  }
  info(`(timed out waiting for ${what})`);
  return null;
}

// ---------------------------------------------------------------- the board's WebSocket

type Watcher = { id: string; kind: "bot" | "device"; name?: string; deviceId?: string; state: string };
type WatchersFrame = { type: "watchers"; limit: number; max: number; standby: number; watchers: Watcher[] };
type Frame = { type: string; deviceId?: string; power?: string | null; climate?: any; states?: Record<string, Facts> };
class Board {
  frames: { at: number; frame: Frame }[] = [];
  closed = false;
  private ws: WebSocket;
  opened: Promise<void>;
  constructor() {
    const url = `${origin.replace("http", "ws")}/api/v1/merchant/machines/ws?shopId=${shop.id}`;
    this.ws = new (WebSocket as unknown as new (u: string, o: unknown) => WebSocket)(url, {
      headers: { authorization: `Bearer ${owner.token}`, origin: "http://localhost:8787" },
    });
    this.opened = new Promise((done) => (this.ws.onopen = () => done()));
    this.ws.onmessage = (event) => this.frames.push({ at: Date.now(), frame: JSON.parse(String(event.data)) });
    this.ws.onclose = () => (this.closed = true);
  }
  /** Who the hub last said is watching Home Assistant, as `bot:<name>` and `io:<A|B>`, in a stable order. */
  watchers(): string[] {
    const frame = this.frames.map((entry) => entry.frame as unknown as WatchersFrame).filter((item) => item.type === "watchers").at(-1);
    return (frame?.watchers ?? []).map((watcher) => (watcher.kind === "bot" ? `bot:${watcher.name}` : `io:${watcher.deviceId === A ? "A" : "B"}`)).sort();
  }
  lastWatchers(): WatchersFrame | undefined {
    return this.frames.map((entry) => entry.frame as unknown as WatchersFrame).filter((item) => item.type === "watchers").at(-1);
  }
  /** Wait until exactly these are watching, every one of them with its state delivered. */
  async watchedBy(expected: string[], ms = 25_000): Promise<boolean> {
    const want = [...expected].sort().join(",");
    return !!(await until(`the watchers to be ${want || "nobody"}`, () => this.watchers().join(",") === want && (this.lastWatchers()?.watchers.every((watcher) => watcher.state === "watching") ?? false), ms));
  }
  mark(): number {
    return this.frames.length;
  }
  async wait(predicate: (frame: Frame) => boolean, from: number, ms = 6000) {
    return until("a board frame", () => this.frames.slice(from).find((entry) => predicate(entry.frame)), ms);
  }
  /** True if no frame matching `predicate` arrives within `ms`. */
  async quiet(predicate: (frame: Frame) => boolean, from: number, ms = 2500): Promise<boolean> {
    await Bun.sleep(ms);
    return !this.frames.slice(from).some((entry) => predicate(entry.frame));
  }
  /** The facts for a device as of the frames so far (a `states` frame replaces, a `state` frame patches). */
  seen(deviceId: string): Partial<Facts> {
    let facts: Partial<Facts> = {};
    for (const { frame } of this.frames) {
      if (frame.type === "states" && frame.states?.[deviceId]) facts = { ...frame.states[deviceId] };
      if (frame.type === "state" && frame.deviceId === deviceId) {
        if (frame.power !== undefined) facts.power = frame.power;
        if (frame.climate !== undefined) facts.climate = frame.climate;
      }
    }
    return facts;
  }
  close() {
    this.ws.close();
  }
}
const aboutDevice = (id: string) => (frame: Frame) => frame.type === "state" ? frame.deviceId === id : !!frame.states?.[id];
const watchingFrame = (id: string, watching: boolean) => (frame: Frame) => frame.type === "states" && frame.states?.[id]?.watching === watching;

// ---------------------------------------------------------------- the real IO client

class Io {
  private child: ChildProcess | null = null;
  readonly logFile: string;
  constructor(readonly name: "a" | "b") {
    this.logFile = `.e2e/io/${name}.log`;
  }
  start(): void {
    if (this.alive) throw new Error(`io ${this.name} is already running`);
    const fd = openSync(this.logFile, "w");
    this.child = spawn(IO_BIN, [], {
      cwd: ".e2e/io",
      env: { ...process.env, SEGATOOLS_CONFIG_PATH: resolve(`.e2e/io/${this.name}.ini`), RUST_LOG: "hinata_mac_test=debug" },
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
  }
  signal(name: NodeJS.Signals): void {
    this.child?.kill(name);
  }
  get log(): string {
    return readFileSync(this.logFile, "utf8");
  }
  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }
  async kill(): Promise<void> {
    if (!this.alive) return;
    this.signal("SIGCONT");
    this.signal("SIGKILL");
    await until("io exit", () => !this.alive, 3000);
  }
}
const ioA = new Io("a");
const ioB = new Io("b");

/** A shop bot: the real plugin in its own process (`bot-sim.ts`), called by name on the board. */
class Bot {
  private child: ChildProcess | null = null;
  constructor(readonly name: string, private readonly slot: number) {}
  start(): void {
    if (this.alive) throw new Error(`bot ${this.name} is already running`);
    const fd = openSync(`.e2e/bot-${this.slot}.log`, "w");
    this.child = spawn(process.execPath, ["run", "scripts/e2e-ha/bot-sim.ts"], {
      cwd: root,
      env: { ...process.env, BOT_NAME: this.name },
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
  }
  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }
  async kill(): Promise<void> {
    if (!this.alive) return;
    this.child!.kill("SIGKILL");
    await until("bot exit", () => !this.alive, 3000);
  }
}
const botFront = new Bot("前台", 1);
const botBack = new Bot("后台", 2);
const stopAllIo = async () => {
  spawnSync("pkill", ["-x", "io_sim"]);
  spawnSync("pkill", ["-f", "e2e-ha/bot-sim.ts"]);
  await ioA.kill();
  await ioB.kill();
  await botFront.kill();
  await botBack.kill();
};

// ---------------------------------------------------------------- scenarios

const A = devices.a.id;
const B = devices.b.id;
const L = devices.lounge.id;
const scenarios: Record<string, () => Promise<void>> = {};

scenarios.baseline = async () => {
  section("1 没有 IO 时全店都是非实时：看板状态来自 HA");
  const t0 = new Date().toISOString();
  const states = await boardStates();
  check("三台设备都不是实时", [A, B, L].every((id) => states[id]?.watching === false), states);
  check("机台A 电源/空调取自 HA", states[A]?.power === "on" && states[A]?.climate?.mode === "cool" && states[A]?.climate?.temperature === 21, states[A]);
  check("机台B 电源取自 HA", states[B]?.power === "off", states[B]);
  check("休息室 电源/空调取自 HA", states[L]?.power === "off" && states[L]?.climate?.mode === "heat", states[L]);
  await Bun.sleep(500);
  const reads = platformReads(t0).sort();
  info(`HA 收到平台读取：${reads.join(", ")}`);
  check(
    "每个实体恰好被平台读了一次",
    JSON.stringify(reads) === JSON.stringify(["climate.heatpump", "climate.hvac", "input_boolean.lounge_power", "switch.ac", "switch.decorative_lights"]),
    reads,
  );
  info(`平台读 HA 的 User-Agent：${[...new Set(haRequests(t0).map((request) => request.ua))].join(" | ")}`);

  const t1 = new Date().toISOString();
  const one = (await api(`/api/v1/merchant/machines/${L}/state`)).body;
  check("单台读取（休息室）取自 HA", one.watching === false && one.power === "off" && one.climate?.mode === "heat", one);
  await Bun.sleep(400);
  check("单台读取只读该设备的两个实体", JSON.stringify(platformReads(t1).sort()) === JSON.stringify(["climate.heatpump", "input_boolean.lounge_power"]), platformReads(t1));

  const board = new Board();
  await board.opened;
  await Bun.sleep(1200);
  // Besides the devices, the hub also says who is watching; that is asserted on its own (scenario 18).
  const framesOnOpen = board.frames.map((entry) => entry.frame).filter((frame) => frame.type !== "watchers");
  info(`看板 WS 刚连上收到：${JSON.stringify(framesOnOpen).slice(0, 200)}`);
  const carriesValue = (facts: Facts) => facts.power !== null || facts.climate !== null;
  check(
    "没有实时设备时 WS 只告知「非实时」，不带任何设备状态",
    framesOnOpen.length > 0 && framesOnOpen.every((frame) => frame.type === "states" && Object.values(frame.states ?? {}).every((facts) => !facts.watching && !carriesValue(facts))),
    framesOnOpen,
  );
  const t2 = new Date().toISOString();
  await haCall("input_boolean", "turn_on", { entity_id: "input_boolean.lounge_power" });
  const mark = board.mark();
  check("非实时设备的 HA 变化不会被推送", await board.quiet(aboutDevice(L), mark));
  const after = await boardStates();
  check("刷新（HTTP）才读到新值", after[L]?.power === "on", after[L]);
  await haCall("input_boolean", "turn_off", { entity_id: "input_boolean.lounge_power" });
  board.close();
};

scenarios.live = async () => {
  section("2 启动机台A 的 IO：首次快照后连接才算实时");
  const board = new Board();
  await board.opened;
  const mark = board.mark();
  const before = liveConnections();
  check("启动前没有实时连接", before.length === 0, before);
  ioA.start();
  const first = await board.wait(watchingFrame(A, true), mark, 15_000);
  check("看板收到 A、B 的实时快照 (states 帧)", !!first && !!first.frame.states?.[B]?.watching, first?.frame);
  const facts = board.seen(A);
  check("快照带电源和空调", facts.power === "on" && facts.climate?.temperature === 21, facts);
  check("B 的快照带电源", board.seen(B).power === "off", board.seen(B));
  const loungeFacts = first?.frame.states?.[L];
  check("休息室在帧里是非实时，且不带值", loungeFacts?.watching === false && loungeFacts.power === null && loungeFacts.climate === null, loungeFacts);
  check("D1 记下了这条 HA 连接", liveConnections().length === 1, liveConnections());
  check("IO 日志：收到监听任务", /Watching 1 Home Assistant/.test(ioA.log), ioA.log.slice(-300));

  section("3 实时：HA 一变，看板立刻收到推送");
  let m = board.mark();
  let started = Date.now();
  await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
  const power = await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.power === "off", m);
  check("机台A 电源推送", !!power, board.frames.slice(m));
  if (power) info(`HA 变化 → 看板 ${power.at - started} ms`);
  m = board.mark();
  started = Date.now();
  await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 24 });
  const climate = await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.climate?.temperature === 24, m);
  check("机台A 空调温度推送", !!climate);
  if (climate) info(`HA 变化 → 看板 ${climate.at - started} ms`);
  m = board.mark();
  await haCall("switch", "turn_on", { entity_id: "switch.ac" });
  check("机台B 电源推送", !!(await board.wait((frame) => frame.type === "state" && frame.deviceId === B && frame.power === "on", m)));
  m = board.mark();
  await haCall("input_boolean", "turn_on", { entity_id: "input_boolean.lounge_power" });
  check("休息室(非实时)的变化不推送", await board.quiet(aboutDevice(L), m));

  section("4 看板读取：实时设备零读取，只读非实时的休息室");
  const t0 = new Date().toISOString();
  const states = await boardStates();
  await Bun.sleep(500);
  const reads = platformReads(t0).sort();
  info(`HA 收到平台读取：${reads.join(", ")}`);
  check("A、B 来自事实，值是最新的", states[A]?.watching === true && states[A]?.power === "off" && states[A]?.climate?.temperature === 24 && states[B]?.power === "on", [states[A], states[B]]);
  check("休息室来自 HA 且是最新值", states[L]?.watching === false && states[L]?.power === "on", states[L]);
  check("平台只读了休息室的两个实体", JSON.stringify(reads) === JSON.stringify(["climate.heatpump", "input_boolean.lounge_power"]), reads);

  section("5 通过平台操作实时设备：不回读，结果靠推送");
  const t1 = new Date().toISOString();
  m = board.mark();
  const on = await act("a", "power.on");
  check("power.on 成功", on.status === 200, on);
  const pushed = await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.power === "on", m);
  check("操作结果来自推送", !!pushed);
  const adjust = await act("a", "climate.set_temperature", { temperature: 22 });
  check("climate.set_temperature 成功", adjust.status === 200, adjust);
  check("温度推送", !!(await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.climate?.temperature === 22, m)));
  await Bun.sleep(400);
  const readsAfterAction = platformReads(t1);
  check("操作期间平台没有读 A 的任何实体", !readsAfterAction.some((entity) => /decorative_lights|hvac/.test(entity)), readsAfterAction);

  section("6 通过平台操作非实时设备：只重读这一台");
  const t2 = new Date().toISOString();
  const lounge = await act("lounge", "power.off");
  check("休息室 power.off 成功", lounge.status === 200, lounge);
  const reread = (await api(`/api/v1/merchant/machines/${L}/state`)).body;
  check("重读该设备得到新值", reread.power === "off", reread);
  await Bun.sleep(400);
  const readsLounge = platformReads(t2).sort();
  check("只读了休息室的实体", readsLounge.every((entity) => /lounge_power|heatpump/.test(entity)) && readsLounge.length > 0, readsLounge);
  board.close();
};

const goLive = async (board: Board, io: Io, ms = 20_000) => {
  const mark = board.mark();
  io.start();
  return board.wait(watchingFrame(A, true), mark, ms);
};
const logTail = (io: Io, from: number) => io.log.split("\n").slice(from).filter(Boolean);

scenarios.dedupe = async () => {
  section("7 两个 IO 同时监听：同一变化只记录一次");
  const board = new Board();
  await board.opened;
  check("机台A 的 IO 上线 → 实时", !!(await goLive(board, ioA)));
  const afterA = eventCount(A, "power");
  const snapshot = board.mark();
  ioB.start();
  await until("B 收到监听任务", () => /Watching 1 Home Assistant/.test(ioB.log), 15_000);
  check("机台B 的 IO 也收到监听任务", /Watching 1 Home Assistant/.test(ioB.log), ioB.log.slice(-300));
  await Bun.sleep(2500);
  check("B 加入后重复的快照没有产生新事件", eventCount(A, "power") === afterA, [afterA, eventCount(A, "power")]);
  check("B 加入不改变看板上的实时状态", await board.quiet(watchingFrame(A, false), snapshot, 500));

  const marks = [ioA.log.split("\n").length, ioB.log.split("\n").length];
  const events = eventCount(A, "power");
  let m = board.mark();
  await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
  check("变化推到看板", !!(await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.power === "off", m)));
  await Bun.sleep(1500);
  info(`A 日志新增：${logTail(ioA, marks[0]!).join(" / ").slice(0, 240) || "(无)"}`);
  info(`B 日志新增：${logTail(ioB, marks[1]!).join(" / ").slice(0, 240) || "(无)"}`);
  check("两个监听器看到同一变化，只写一次事件", eventCount(A, "power") === events + 1, [events, eventCount(A, "power")]);
  const pushes = board.frames.slice(m).filter((entry) => entry.frame.type === "state" && entry.frame.deviceId === A && entry.frame.power === "off");
  check("看板只收到一条推送", pushes.length === 1, pushes.length);

  // A frozen process sends no close frame, so nothing can have been handed over to B: a push while A
  // is frozen can only come from B watching at the same time.
  ioA.signal("SIGSTOP");
  m = board.mark();
  const frozen = Date.now();
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  const viaB = await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.power === "on", m, 4000);
  check("A 被冻结时，B 仍立刻推送（两个监听器同时在监听）", !!viaB);
  if (viaB) info(`A 冻结 → HA 变化 → 看板 ${viaB.at - frozen} ms`);
  ioA.signal("SIGCONT");
  board.close();
};

scenarios.handover = async () => {
  section("8 监听器断开：一个断开仍实时，全断开立刻非实时，值保留靠客户端");
  const board = new Board();
  await board.opened;
  await goLive(board, ioA);
  ioB.start();
  await until("B 收到监听任务", () => /Watching 1 Home Assistant/.test(ioB.log), 15_000);
  await Bun.sleep(2000);

  let m = board.mark();
  await ioA.kill();
  check("只断开 A：连接仍然实时（不发非实时帧）", await board.quiet((frame) => frame.type === "states" && Object.values(frame.states ?? {}).some((facts) => facts.watching === false && facts !== frame.states?.[L]), m, 3500));
  check("D1 里这条连接仍是实时", liveConnections().length === 1, liveConnections());
  m = board.mark();
  await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
  check("A 断开后由 B 继续推送", !!(await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.power === "off", m)));

  m = board.mark();
  const killed = Date.now();
  await ioB.kill();
  const down = await board.wait(watchingFrame(A, false), m, 10_000);
  check("两个监听器都断开：立刻变成非实时", !!down && !!down.frame.states?.[B] && down.frame.states[B]!.watching === false, down?.frame);
  if (down) info(`最后一个监听器断开 → 看板收到非实时帧 ${down.at - killed} ms`);
  check("D1 的实时连接被撤销", liveConnections().length === 0, liveConnections());

  m = board.mark();
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  check("非实时后 HA 变化不推送", await board.quiet(aboutDevice(A), m));
  const t0 = new Date().toISOString();
  const states = await boardStates();
  await Bun.sleep(500);
  const truth = { a: (await haState("switch.decorative_lights")).state, b: (await haState("switch.ac")).state };
  check("读取时 A、B 回到 HA 直读，值与 HA 此刻一致", states[A]?.watching === false && states[A]?.power === truth.a && states[B]?.watching === false && states[B]?.power === truth.b, [truth, states[A]?.power, states[B]?.power]);
  check("平台读了 A、B 的实体", ["switch.decorative_lights", "climate.hvac", "switch.ac"].every((entity) => platformReads(t0).includes(entity)), platformReads(t0));

  section("9 重新上线：第一次快照就是当前值");
  await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
  await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 26 });
  m = board.mark();
  ioA.start();
  const again = await board.wait(watchingFrame(A, true), m, 20_000);
  check("重新实时", !!again);
  check("快照里是离线期间 HA 里变化后的值", again?.frame.states?.[A]?.power === "off" && again.frame.states[A]!.climate?.temperature === 26, again?.frame.states?.[A]);
  check("D1 重新记下实时连接", liveConnections().length === 1, liveConnections());
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 21 });
  board.close();
};

scenarios.poweroff = async () => {
  section("10 平台把机台断电：这台 IO 的监听立刻让出，不等租约");
  const board = new Board();
  await board.opened;
  check("只有机台A 的 IO 在线 → 实时", !!(await goLive(board, ioA)));
  let m = board.mark();
  let at = Date.now();
  const off = await act("a", "power.off");
  check("平台 power.off 成功", off.status === 200, off);
  const down = await board.wait(watchingFrame(A, false), m, 8000);
  check("唯一的监听器被断电：立刻变成非实时", !!down);
  if (down) info(`power.off → 看板收到非实时帧 ${down.at - at} ms（租约要 ${LEASE_MS / 1000}s）`);
  check("D1 的实时连接被撤销", liveConnections().length === 0, liveConnections());
  check("断电的 IO 进程虽然还连着，也不再监听（日志里没有被重新分配）", ioA.alive);
  m = board.mark();
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  check("之后 HA 的变化不推送", await board.quiet(aboutDevice(A), m, 3000));
  check("断电的 IO 不会被立刻重新选中", liveConnections().length === 0, liveConnections());

  m = board.mark();
  await ioA.kill();
  at = Date.now();
  check("机台重新上电（IO 重新启动并连接）→ 又变成实时", !!(await goLive(board, ioA)));
  check("重新实时后快照是当前值", board.seen(A).power === "on", board.seen(A));

  section("11 两个监听器时，只断一台的电：连接仍然实时");
  ioB.start();
  await until("B 收到监听任务", () => /Watching 1 Home Assistant/.test(ioB.log), 15_000);
  await Bun.sleep(2000);
  m = board.mark();
  await act("a", "power.off");
  check("A 被断电：连接仍然实时（B 在监听）", await board.quiet(watchingFrame(A, false), m, 3500));
  m = board.mark();
  await haCall("switch", "turn_on", { entity_id: "switch.ac" });
  check("B 继续推送", !!(await board.wait((frame) => frame.type === "state" && frame.deviceId === B && frame.power === "on", m)));
  m = board.mark();
  at = Date.now();
  await act("b", "power.off");
  const both = await board.wait(watchingFrame(A, false), m, 8000);
  check("再断 B 的电：立刻变成非实时", !!both);
  if (both) info(`power.off → 看板收到非实时帧 ${both.at - at} ms`);
  board.close();
};

scenarios.lease = async () => {
  section("12 监听器静默（进程冻结、连接不断）：靠租约判定离线，恢复后自动重新实时");
  const board = new Board();
  await board.opened;
  check("机台A 的 IO 上线 → 实时", !!(await goLive(board, ioA)));
  ioA.signal("SIGSTOP");
  const frozen = Date.now();
  let m = board.mark();
  await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
  check("冻结期间 HA 变化推不出来（没有别的监听器）", await board.quiet(aboutDevice(A), m, 3000));
  check("冻结 3s 后仍显示实时（租约还没到期）", liveConnections().length === 1, liveConnections());
  info(`等待租约到期（最长 ${(LEASE_MS + 45_000) / 1000}s）…`);
  const down = await board.wait(watchingFrame(A, false), m, LEASE_MS + 45_000);
  check("租约到期：变成非实时", !!down);
  const waited = down ? down.at - frozen : -1;
  if (down) info(`冻结 → 非实时帧 ${(waited / 1000).toFixed(1)}s`);
  check("到期时间落在租约之内（最后一次上报起算 ≤ 90s，加报警延迟）", waited > 40_000 && waited <= LEASE_MS + 30_000, waited);
  check("D1 的实时连接被撤销", liveConnections().length === 0, liveConnections());
  m = board.mark();
  ioA.signal("SIGCONT");
  const back = await board.wait(watchingFrame(A, true), m, 60_000);
  check("进程恢复后，hub 重新下发监听 → 重新实时", !!back);
  check("恢复后的快照是冻结期间变化后的当前值", back?.frame.states?.[A]?.power === "off", back?.frame.states?.[A]);
  board.close();
};

scenarios.hadown = async () => {
  section("13 HA 自己重启（IO 与 HA 的连接断开）：看板变成非实时，HA 回来后重新实时");
  const board = new Board();
  await board.opened;
  check("机台A 的 IO 上线 → 实时", !!(await goLive(board, ioA)));
  const m = board.mark();
  const restarted = Date.now();
  spawnSync("docker", ["restart", "-t", "2", "prism-e2e-ha"]);
  const down = await board.wait(watchingFrame(A, false), m, 60_000);
  check("HA 断开：看板变成非实时", !!down);
  if (down) info(`HA 重启 → 非实时帧 ${((down.at - restarted) / 1000).toFixed(1)}s`);
  check("D1 的实时连接被撤销", liveConnections().length === 0, liveConnections());
  const started = Date.now();
  const during = await api(`/api/v1/merchant/machines/states?shopId=${shop.id}`);
  info(`HA 不可用时读取：HTTP ${during.status}，耗时 ${Date.now() - started} ms，A=${JSON.stringify(during.body?.states?.[A])?.slice(0, 80)}`);
  check("HA 不可用时读取不报错、不卡住", during.status === 200 && Date.now() - started < 20_000, during.status);
  check("HA 不可用时该设备的值为空（客户端据此保留旧值）", during.body?.states?.[A]?.watching === false && during.body.states[A].power === null, during.body?.states?.[A]);
  const back = await board.wait(watchingFrame(A, true), m, 150_000);
  check("HA 恢复后重新实时", !!back);
  if (back) info(`HA 重启 → 重新实时 ${((back.at - restarted) / 1000).toFixed(1)}s`);
  const truth = { power: (await haState("switch.decorative_lights")).state, temperature: (await haState("climate.hvac")).attributes.temperature };
  check("新的快照与 HA 此刻一致", back?.frame.states?.[A]?.power === truth.power && back?.frame.states?.[A]?.climate?.temperature === truth.temperature, [truth, back?.frame.states?.[A]]);
  board.close();
};

scenarios.backfill = async () => {
  section("16 功能上线前存下的连接（没有只读账号）：IO 上线时自动补建，换掉而不是叠加");
  const KEY = "e2e-url-encryption-key";
  type Row = { key: string; readAccess?: string; readToken?: string | null; url: string };
  const rows = () => (d1().query("SELECT key, value_json FROM app_settings WHERE shop_id=? AND key LIKE 'devices.ha_connection:%'").all(shop.id) as { key: string; value_json: string }[])
    .map((row) => ({ key: row.key, ...JSON.parse(row.value_json) }) as Row);
  const watched = rows().find((row) => row.readToken)!;
  const unreachable = rows().find((row) => row.readAccess === "needs_admin")!;
  const before = await decryptSecret(watched.readToken!, KEY);
  const state = (token: string) => fetch(`${ha.url}/api/states/switch.decorative_lights`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.status);
  check("补建前：原来的只读令牌有效", (await state(before)) === 200);

  // What a connection saved before read-only accounts existed looks like: no token, never tried.
  const stripped = spawnSync("scripts/e2e-ha/d1.sh", [
    `UPDATE app_settings SET value_json=json_remove(json_remove(value_json,'$.readAccess'),'$.readToken') WHERE shop_id='${shop.id}' AND key='${watched.key}'`,
  ], { encoding: "utf8" });
  check("把这条连接改成「从没尝试过」的样子", stripped.status === 0 && rows().find((row) => row.key === watched.key)!.readAccess === undefined, stripped.stdout + stripped.stderr);

  const board = new Board();
  await board.opened;
  const started = Date.now();
  const live = await goLive(board, ioA, 60_000);
  check("机台A 的 IO 上线 → 平台自动建了只读账号，随后变成实时（不用任何人点按钮）", !!live);
  if (live) info(`IO 上线 → 实时 ${((live.at - started) / 1000).toFixed(1)}s（含在真实 HA 里建账号）`);
  const after = rows().find((row) => row.key === watched.key)!;
  check("这条连接现在是 ready，且有新的只读令牌", after.readAccess === "ready" && !!after.readToken, after);
  const next = after.readToken ? await decryptSecret(after.readToken, KEY) : "";
  check("新令牌与原来的不同，并且能读", !!next && next !== before && (await state(next)) === 200);
  check("原来的只读账号被换掉了（旧令牌失效），HA 里没有留下第二个能用的账号", (await state(before)) === 401, await state(before));
  const other = rows().find((row) => row.key === unreachable.key)!;
  check("非管理员令牌的那条连接没有被反复尝试：仍是 needs_admin", other.readAccess === "needs_admin" && !other.readToken, other);
  board.close();
};

scenarios.urls = async () => {
  section("17 内部地址不可达（HA 在别处托管，或监听器不在店里）：连接超时后转到下一个地址");
  const row = (d1().query("SELECT key, value_json FROM app_settings WHERE shop_id=? AND key LIKE 'devices.ha_connection:%'").all(shop.id) as { key: string; value_json: string }[])
    .find((entry) => JSON.parse(entry.value_json).readToken)!;
  const set = (expression: string) => spawnSync("scripts/e2e-ha/d1.sh", [`UPDATE app_settings SET value_json=${expression} WHERE shop_id='${shop.id}' AND key='${row.key}'`], { encoding: "utf8" });
  // 192.0.2.0/24 is reserved for documentation: nothing answers, nothing refuses, the connection just hangs.
  set("json_set(value_json,'$.internalUrl','http://192.0.2.1:8123')");
  const board = new Board();
  try {
    await board.opened;
    const started = Date.now();
    const live = await goLive(board, ioA, 40_000);
    const seconds = live ? (live.at - started) / 1000 : null;
    check("第一个地址不可达：约一个连接超时（10s）后用第二个地址变成实时，而不是等操作系统放弃（macOS 约 75s）", !!live && seconds! < 25, seconds);
    if (seconds !== null) info(`IO 上线 → 实时 ${seconds.toFixed(1)}s`);

    // The address that worked is tried first, so a restart costs a round or two, not a wait on the dead one each time.
    const mark = board.mark();
    const restarted = Date.now();
    spawnSync("docker", ["restart", "-t", "2", "prism-e2e-ha"]);
    const down = await board.wait(watchingFrame(A, false), mark, 60_000);
    check("HA 重启：看板变成非实时", !!down);
    const back = down ? await board.wait(watchingFrame(A, true), board.frames.indexOf(down) + 1, 120_000) : null;
    const recovered = back ? (back.at - restarted) / 1000 : null;
    check("HA 回来后重新实时，不被不可达的内部地址拖住（旧行为每一轮都要等 75s）", !!back && recovered! < 45, recovered);
    if (recovered !== null) info(`HA 重启 → 重新实时 ${recovered.toFixed(1)}s`);
  } finally {
    set("json_remove(value_json,'$.internalUrl')");
    board.close();
  }
};

scenarios.readonly = async () => {
  section("14 平台自动建的只读账号：能读不能控（真实 Home Assistant）");
  const rows = d1().query("SELECT value_json FROM app_settings WHERE shop_id=? AND key LIKE 'devices.ha_connection:%'").all(shop.id) as { value_json: string }[];
  const connections = rows.map((row) => JSON.parse(row.value_json) as { id: string; token: string; readToken: string | null });
  const withRead = connections.filter((connection) => connection.readToken);
  check("只有管理员令牌那条连接有只读令牌", withRead.length === 1 && connections.length === 2, connections.map((c) => [c.id, !!c.readToken]));
  const readToken = await decryptSecret(withRead[0]!.readToken!, "e2e-url-encryption-key");
  const controlToken = await decryptSecret(withRead[0]!.token, "e2e-url-encryption-key");
  check("只读令牌与控制令牌是两个不同的令牌", readToken !== controlToken && readToken !== ha.adminToken);
  const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  const read = await fetch(`${ha.url}/api/states/switch.decorative_lights`, { headers: as(readToken) });
  check("只读令牌能读实体状态", read.status === 200, read.status);
  const before = (await haState("switch.decorative_lights")).state;
  const off = await fetch(`${ha.url}/api/services/switch/${before === "on" ? "turn_off" : "turn_on"}`, {
    method: "POST", headers: as(readToken), body: JSON.stringify({ entity_id: "switch.decorative_lights" }),
  });
  await Bun.sleep(300);
  check("只读令牌调用开关服务被 HA 拒绝", off.status === 401 || off.status === 403, off.status);
  check("被拒绝后开关没有变化", (await haState("switch.decorative_lights")).state === before);
  const temperature = (await haState("climate.hvac")).attributes.temperature;
  const climate = await fetch(`${ha.url}/api/services/climate/set_temperature`, {
    method: "POST", headers: as(readToken), body: JSON.stringify({ entity_id: "climate.hvac", temperature: 30 }),
  });
  await Bun.sleep(300);
  check("只读令牌调用空调服务也被拒绝，温度没变", (climate.status === 401 || climate.status === 403) && (await haState("climate.hvac")).attributes.temperature === temperature, [climate.status]);
  const control = await fetch(`${ha.url}/api/states/switch.decorative_lights`, { headers: as(controlToken) });
  check("控制令牌（店家给的）仍然有效", control.status === 200, control.status);
};

scenarios.idle = async () => {
  section("15 空闲自动关机：店里没人满 1 分钟，全部电源和空调都被关掉（不靠存储的状态）");
  const board = new Board();
  await board.opened;
  check("机台A 的 IO 上线 → A、B 实时（休息室没有任何状态）", !!(await goLive(board, ioA)));
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  await haCall("switch", "turn_on", { entity_id: "switch.ac" });
  await haCall("input_boolean", "turn_on", { entity_id: "input_boolean.lounge_power" });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.hvac", hvac_mode: "cool" });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.heatpump", hvac_mode: "heat" });
  const entities = ["switch.decorative_lights", "switch.ac", "input_boolean.lounge_power", "climate.hvac", "climate.heatpump"];
  try {
    await Bun.sleep(500);
    const m = board.mark();
    const set = await api(`/api/v1/merchant/idle-power?shopId=${shop.id}`, { method: "PUT", body: JSON.stringify({ shopEmpty: { enabled: true, minutes: 1 } }) });
    check("设置「店里没人 1 分钟后关机」", set.status === 200, set);
    const started = Date.now();
    const states = await until("everything to be switched off", async () => {
      const now = await Promise.all(entities.map(async (entity) => [entity, (await haState(entity)).state] as const));
      return now.every(([, state]) => state === "off") ? now : null;
    }, 170_000);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    check(`${seconds}s 后五个实体全部关闭（实时的 A、B 和没有状态的休息室，电源和空调都在内）`, !!states, await Promise.all(entities.map(async (entity) => [entity, (await haState(entity)).state])));
    const down = await board.wait(watchingFrame(A, false), m, 8000);
    check("被平台关掉电源的机台，IO 立刻让出监听：看板变成非实时", !!down);
    check("D1 的实时连接被撤销", liveConnections().length === 0, liveConnections());
  } finally {
    await api(`/api/v1/merchant/idle-power?shopId=${shop.id}`, { method: "PUT", body: JSON.stringify({ shopEmpty: { enabled: false, minutes: 15 } }) });
    board.close();
  }
};

scenarios.bots = async () => {
  section("18 Bot 当监听器：Bot 优先于机台，让位没有空窗，数量由平台管理员按店铺设置");
  const board = new Board();
  await board.opened;
  const setLimit = (count: number, as: string) =>
    api(`/api/v1/merchant/ha-watchers?shopId=${shop.id}`, { method: "PUT", body: JSON.stringify({ count }), as });
  /** The board never heard the connection stop being live since `from`. */
  const noGap = (from: number) => !board.frames.slice(from).some((entry) => entry.frame.type === "states" && entry.frame.states?.[A]?.watching === false);
  const pushesOf = (from: number) =>
    board.frames.slice(from).filter((entry) => entry.frame.type === "state" && entry.frame.deviceId === A && entry.frame.power !== undefined);
  /** Flip the switch A is on and say how many times the board was told. */
  const flip = async (to: "on" | "off") => {
    const from = board.mark();
    await haCall("switch", to === "on" ? "turn_on" : "turn_off", { entity_id: "switch.decorative_lights" });
    await board.wait((frame) => frame.type === "state" && frame.deviceId === A && frame.power === to, from, 6000);
    await Bun.sleep(1200);
    return pushesOf(from).length;
  };
  try {
    // The hub sends who is watching right after the board connects, a moment after the socket opens.
    const first = await until("the first watcher list", () => board.lastWatchers(), 5000);
    check("没有任何监听器时，看板收到「名额 2、最多 4、没有人在监听」", first?.limit === 2 && first.max === 4 && first.watchers.length === 0, first);

    ioA.start();
    await until("A to take the watch", () => /Watching 1 Home Assistant/.test(ioA.log), 15_000);
    ioB.start();
    check("只有两台机台在线：两个名额都是机台", await board.watchedBy(["io:A", "io:B"]), board.watchers());

    let m = board.mark();
    botFront.start();
    check("前台 Bot 上线：Bot 顶掉一台机台，另一个名额仍是先上线的机台 A", await board.watchedBy(["bot:前台", "io:A"]), board.watchers());
    check("让位没有空窗：整个过程看板没有听到一次「不再实时」", noGap(m));
    check("Bot 和机台同时在监听，同一个变化只推一次", (await flip("off")) === 1);
    await flip("on");

    m = board.mark();
    botBack.start();
    check("后台 Bot 也上线：两个名额都给 Bot，机台让出", await board.watchedBy(["bot:前台", "bot:后台"]), board.watchers());
    check("让位没有空窗", noGap(m));
    check("两个 Bot 同时监听，同一个变化也只推一次", (await flip("off")) === 1);
    await flip("on");

    m = board.mark();
    await botFront.kill();
    check("一个 Bot 掉线：机台立刻补上空位，另一个 Bot 继续", await board.watchedBy(["bot:后台", "io:A"], 15_000), board.watchers());
    check("掉线与补位期间没有空窗", noGap(m));
    m = board.mark();
    await botBack.kill();
    check("两个 Bot 都掉线：回到两台机台", await board.watchedBy(["io:A", "io:B"], 15_000), board.watchers());
    check("没有空窗（机台 A 一直在监听）", noGap(m));

    const asOwner = await setLimit(1, owner.token);
    check("店主不能改监听器数量（403）", asOwner.status === 403, asOwner);
    await Bun.sleep(500);
    check("数量没变", board.lastWatchers()?.limit === 2, board.lastWatchers());
    const asAdmin = await setLimit(1, admin.token);
    check("平台管理员可以改（200）", asAdmin.status === 200, asAdmin);
    check("数量改成 1：只剩一台机台在监听，看板收到新的数量", (await board.watchedBy(["io:A"])) && board.lastWatchers()?.limit === 1, board.lastWatchers());

    botFront.start();
    await until("the first bot to hello", () => board.watchers().some((entry) => entry.startsWith("bot:")), 15_000);
    await Bun.sleep(1500);
    botBack.start();
    // The second bot only counts once the hub has heard from it, which is after the first one already held the slot.
    check("多出来的在线客户端算候补（机台 A、机台 B、后台 Bot 共 3 个）", !!(await until("three standing by", () => board.lastWatchers()?.standby === 3, 10_000)), board.lastWatchers());
    check("数量为 1 时，一个 Bot 就占满，后上线的 Bot 和机台都不监听", await board.watchedBy(["bot:前台"]), board.watchers());

    check("数量改成 4：两个 Bot 和两台机台都在监听", (await setLimit(4, admin.token)).status === 200 && (await board.watchedBy(["bot:前台", "bot:后台", "io:A", "io:B"])), board.watchers());
    check("超过最多 4 个、或小于 1，被拒绝（422）", (await setLimit(5, admin.token)).status === 422 && (await setLimit(0, admin.token)).status === 422);
    check("改回 2：两个 Bot 占满，机台让出", (await setLimit(2, admin.token)).status === 200 && (await board.watchedBy(["bot:前台", "bot:后台"])), board.watchers());

    await stopAllIo();
    check("全部掉线后看板变成没有监听器", await board.watchedBy([], 15_000), board.watchers());
    check("连接回到非实时", !!(await until("not live", () => liveConnections().length === 0, 10_000)), liveConnections());

    m = board.mark();
    botFront.start();
    check("店里只有一个 Bot、没有机台：Bot 单独监听，连接变成实时", (await board.watchedBy(["bot:前台"])) && liveConnections().length === 1, [board.watchers(), liveConnections()]);
    check("它报的变化推到看板", (await flip("off")) === 1);
    await flip("on");
    m = board.mark();
    await botFront.kill();
    check("Bot 掉线：看板立刻收到「不再实时」", !!(await board.wait(watchingFrame(A, false), m, 10_000)));
    check("D1 的实时连接被撤销", liveConnections().length === 0, liveConnections());
  } finally {
    await setLimit(2, admin.token);
    board.close();
  }
};

/** Every scenario starts from the same place: no IO connected, nothing live, Home Assistant at its known values. */
async function reset(): Promise<void> {
  await stopAllIo();
  await resetHa();
  const clear = await until("no live connections", () => liveConnections().length === 0, 15_000);
  if (!clear) failures.push(`reset: live connections remain ${JSON.stringify(liveConnections())}`);
}

const wanted = process.argv.slice(2);
section("准备：杀掉遗留 IO，重置 HA 实体");
await reset();
for (const [name, run] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await reset();
  try {
    await run();
  } catch (error) {
    failures.push(`${name} threw: ${error instanceof Error ? error.stack : error}`);
    console.log(`  FAIL  ${name} threw: ${error instanceof Error ? error.message : error}`);
  }
}
await stopAllIo();
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length ? 1 : 0);
