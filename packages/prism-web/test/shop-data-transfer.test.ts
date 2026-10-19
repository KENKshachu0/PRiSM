import { expect, test } from "bun:test";
import {
  readShopBackup,
  verifyShopBackup,
  uploadShopBackup,
  downloadShopBackup,
  recoverInterruptedShopExport,
} from "../src/shop-data-transfer";
const encoder = new TextEncoder();
function stream(value: string, size = 3) {
  const bytes = encoder.encode(value);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(index, (index += size)));
    },
  });
}
async function read(value: string, size?: number) {
  const rows: unknown[] = [],
    headers: unknown[] = [],
    tables: unknown[] = [];
  const counts = await readShopBackup(stream(value, size), {
    async header(h) {
      headers.push(h);
    },
    async row(table, row) {
      rows.push({ table, row });
    },
    async tableEnd(table, count) {
      tables.push([table, count]);
    },
  });
  return { rows, headers, tables, counts };
}
test("streaming JSON preserves UTC, cents, escaped and multibyte text across byte boundaries", async () => {
  const row = {
    id: '玩家"\\\n',
    started_at: "2026-10-02T02:08:00.000Z",
    amount: 114514,
    timeline_json: JSON.stringify({ label: "日本🎵", quote: '{["\\' }),
  };
  const value = {
    format: "prism-shop-data",
    version: 2,
    tables: { empty: [], players: [row], last: [] },
  };
  const result = await read(JSON.stringify(value));
  expect(result.headers).toEqual([{ format: "prism-shop-data", version: 2 }]);
  expect(result.rows).toEqual([{ table: "players", row }]);
  expect(result.counts).toEqual({ empty: 0, players: 1, last: 0 });
});
test("a row above the former 128 KiB ceiling parses without reading a complete table", async () => {
  const row = { timeline_json: "账单".repeat(90000) };
  const result = await read(
    JSON.stringify({ version: 1, tables: { checkout_timelines: [row, row] } }),
    8192,
  );
  expect(result.rows).toHaveLength(2);
  expect((result.rows[0] as any).row).toEqual(row);
});
test("truncation, duplicate tables/metadata, trailing content and trailing commas fail", async () => {
  for (const value of [
    '{"version":1,"tables":{"players":[{"id":"p"}]}',
    '{"tables":{}} garbage',
    '{"tables":{"p":[],"p":[]}}',
    '{"version":1,"version":2,"tables":{}}',
    '{"tables":{"p":[{},]}}',
    '{"tables":{"p":[],}}',
    '{"tables":{},"version":2}',
    '{"version":2}',
  ])
    await expect(read(value)).rejects.toThrow("请选择有效的 JSON 备份文件");
});

test("download publishes counts before paging and releases a cancelled task during initialization", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController(),
    events: unknown[] = [];
  const info = {
    jobId: "cancelled-init",
    headerJson: "{}",
    tables: ["players"],
    counts: { players: 12345 },
    filename: "backup.json",
  };
  globalThis.fetch = (async (url, init) => {
    events.push([url, init?.method ?? "GET"]);
    if (init?.method === "POST") {
      controller.abort();
      return Response.json({ data: info });
    }
    if (init?.method !== "DELETE")
      throw new Error("Cancelled export must not request a page");
    expect(init.keepalive).toBe(true);
    return Response.json({ data: { deleted: true } });
  }) as typeof fetch;
  try {
    await expect(
      downloadShopBackup("/api/test/data", "business", (n) => events.push(n), {
        signal: controller.signal,
        onStart: (value) => events.push(value.counts),
      }),
    ).rejects.toThrow();
    expect(events).toEqual([
      ["/api/test/data/exports", "POST"],
      { players: 12345 },
      0,
      ["/api/test/data/exports/cancelled-init", "DELETE"],
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("progress advances page by page and the completed JSON remains intact", async () => {
  const original = globalThis.fetch,
    events: unknown[] = [];
  const info = {
    jobId: "progress",
    headerJson: '{"version":2}',
    tables: ["players"],
    counts: { players: 2 },
    filename: "backup.json",
  };
  globalThis.fetch = (async (url, init) => {
    if (init?.method === "POST") return Response.json({ data: info });
    if (init?.method === "DELETE")
      return Response.json({ data: { deleted: true } });
    const cursor = Number(
      new URL(String(url), "https://test.example").searchParams.get("after"),
    );
    expect(events).toEqual(
      cursor === 0
        ? ["start", 0]
        : cursor === 1
          ? ["start", 0, 1]
          : ["start", 0, 1, 2],
    );
    return Response.json({
      data: {
        cursor: cursor < 2 ? cursor + 1 : cursor,
        done: cursor === 2,
        rows:
          cursor < 2
            ? [
                {
                  seq: cursor + 1,
                  table_name: "players",
                  payload_json: JSON.stringify({ id: String(cursor) }),
                },
              ]
            : [],
      },
    });
  }) as typeof fetch;
  try {
    const result = await downloadShopBackup(
      "/api/test/data",
      "business",
      (n) => events.push(n),
      { onStart: () => events.push("start") },
    );
    expect(events).toEqual(["start", 0, 1, 2]);
    expect(JSON.parse(await result.blob.text())).toEqual({
      version: 2,
      tables: { players: [{ id: "0" }, { id: "1" }] },
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("a reloaded tab cancels only its recorded task and retains recovery information if offline", async () => {
  const original = globalThis.fetch,
    previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const store = new Map<string, string>([
    ["prism.export:/api/test/data", "interrupted"],
  ]);
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  let offline = true,
    requests = 0;
  globalThis.fetch = (async (url, init) => {
    requests++;
    expect(url).toBe("/api/test/data/exports/interrupted");
    expect(init?.method).toBe("DELETE");
    expect(init?.keepalive).toBe(true);
    if (offline) throw new TypeError("offline");
    return Response.json({ data: { deleted: true } });
  }) as typeof fetch;
  try {
    await expect(
      recoverInterruptedShopExport("/api/test/data"),
    ).rejects.toThrow("offline");
    expect(store.size).toBe(1);
    offline = false;
    await recoverInterruptedShopExport("/api/test/data");
    await recoverInterruptedShopExport("/api/another/data");
    expect(store.size).toBe(0);
    expect(requests).toBe(2);
  } finally {
    globalThis.fetch = original;
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("pagehide aborts paging and sends a cancellation beacon without waiting for navigation", async () => {
  const original = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const events = new EventTarget(),
    beacons: string[] = [],
    cancellations: RequestInit[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: events,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      sendBeacon: (url: string) => {
        beacons.push(url);
        return true;
      },
    },
  });
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST")
      return Response.json({
        data: {
          jobId: "leaving",
          headerJson: "{}",
          tables: ["players"],
          counts: { players: 2 },
          filename: "backup.json",
        },
      });
    if (init?.method === "DELETE") {
      cancellations.push(init);
      return Response.json({ data: { deleted: true } });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal!.reason),
      );
      entered();
    });
  }) as typeof fetch;
  try {
    const download = downloadShopBackup("/api/test/data", "business", () => {});
    await reading;
    events.dispatchEvent(new Event("pagehide"));
    await expect(download).rejects.toThrow();
    expect(beacons).toEqual(["/api/test/data/exports/leaving/cancel"]);
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]!.keepalive).toBe(true);
    events.dispatchEvent(new Event("pagehide"));
    expect(beacons).toHaveLength(1);
  } finally {
    globalThis.fetch = original;
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("a new tab does not cancel an export whose checkpoint was copied from its opener", async () => {
  const original = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const store = new Map([["prism.export:/api/test/data", "other-live-tab"]]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { performance: { getEntriesByType: () => [{ type: "navigate" }] } },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
    },
  });
  globalThis.fetch = (() => {
    throw new Error("Opening a tab must not cancel another tab's export");
  }) as typeof fetch;
  try {
    await recoverInterruptedShopExport("/api/test/data");
    expect(store.size).toBe(0);
  } finally {
    globalThis.fetch = original;
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousStorage)
      Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});


test("old v2 business backups omit only the new archive table; other missing tables remain invalid", async () => {
  const original = globalThis.fetch;
  const requests: { method: string | undefined; body: unknown }[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push({ method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ data: init?.method === "POST"
      ? { jobId: "job", tables: ["players", "checkout_report_states"] } : { deleted: true } });
  }) as typeof fetch;
  try {
    const digest = async (backup: unknown) =>
      verifyShopBackup(new Blob([JSON.stringify(backup)]), () => {});
    const backup = { version: 2, scope: "business", tables: { players: [] } };
    expect(await uploadShopBackup("/api/data", await digest(backup), () => {}))
      .toEqual({ jobId: "job", counts: { players: 0, checkout_report_states: 0 }, parts: 0 });
    for (const invalidBackup of [
      { version: 2, scope: "business", tables: { checkout_report_states: [] } },
      { version: 1, scope: "business", tables: { players: [] } },
      { version: 2, scope: "configuration", tables: { players: [] } },
    ]) await expect(uploadShopBackup("/api/data", await digest(invalidBackup), () => {})).rejects.toThrow("请选择有效的 JSON 备份文件");
    expect(requests.filter(r => r.method === "DELETE")).toHaveLength(3);
  } finally { globalThis.fetch = original; }
});
