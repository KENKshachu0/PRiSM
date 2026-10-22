import { expect, test } from "bun:test";
import { PagePolling, pollingDelay } from "../src/ui/page-polling";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("page polling continues after successful reads", async () => {
  let reads = 0;
  const polling = new PagePolling(async () => { reads++; }, 10);
  try { polling.refresh(); await wait(70); expect(reads).toBeGreaterThanOrEqual(3); }
  finally { polling.stop(); }
});

test("foreground refresh coalesces events without overlapping reads", async () => {
  let reads = 0, running = 0, maximum = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const polling = new PagePolling(async () => {
    reads++; maximum = Math.max(maximum, ++running);
    if (reads === 1) await held;
    running--;
  }, 1000);
  try {
    polling.refresh(); polling.refresh(); polling.refresh();
    expect(reads).toBe(1);
    release(); await wait(10);
    expect(reads).toBe(2); expect(maximum).toBe(1);
  } finally { release(); polling.stop(); }
});

test("background pauses polling and return immediately refreshes", async () => {
  let reads = 0;
  const polling = new PagePolling(async () => { reads++; }, 10);
  try {
    polling.refresh(); await wait(1); polling.setVisible(false);
    const before = reads; await wait(40); expect(reads).toBe(before);
    polling.setVisible(true); expect(reads).toBe(before + 1);
  } finally { polling.stop(); }
});

test("leaving the page cancels the read and prevents late completion restarting polling", async () => {
  let reads = 0, signal: AbortSignal | undefined;
  let release!: () => void;
  const polling = new PagePolling(async current => {
    reads++; signal = current;
    await new Promise<void>(resolve => { release = resolve; });
  }, 10);
  polling.refresh(); polling.stop();
  expect(signal?.aborted).toBe(true);
  release(); await wait(40); expect(reads).toBe(1);
});

test("binding completion stops repeated reads while foreground can still refresh once", async () => {
  let reads = 0, needsBinding = true;
  const polling = new PagePolling(async () => { reads++; }, 10, () => needsBinding);
  try {
    polling.refresh(); await wait(30); expect(reads).toBeGreaterThan(1);
    needsBinding = false;
    const afterBinding = reads; await wait(40); expect(reads).toBe(afterBinding);
    polling.setVisible(false); polling.setVisible(true);
    expect(reads).toBe(afterBinding + 1);
    await wait(40); expect(reads).toBe(afterBinding + 1);
  } finally { polling.stop(); }
});

test("a page that already has its first read waits an interval before reading, and only if polling is still wanted", async () => {
  let reads = 0, wanted = true;
  const polling = new PagePolling(async () => { reads++; }, 20, () => wanted);
  try {
    polling.deferFirst();
    polling.refresh();
    // Foreground events in the meantime do not bring the first read forward.
    polling.refresh(); polling.setVisible(false); polling.setVisible(true);
    await wait(5); expect(reads).toBe(0);
    await wait(30); expect(reads).toBeGreaterThanOrEqual(1);
  } finally { polling.stop(); }
  let skipped = 0;
  const idle = new PagePolling(async () => { skipped++; }, 10, () => false);
  try {
    idle.deferFirst(); idle.refresh();
    await wait(40); expect(skipped).toBe(0);
  } finally { idle.stop(); }
});

test("failure delays grow to one minute, jitter stays bounded and Retry-After is a floor", () => {
  expect([1,2,3,4,5,6].map(n => pollingDelay(n, 3000, 0, 0.5))).toEqual([5000,10000,20000,30000,60000,60000]);
  expect(pollingDelay(1, 3000, 0, 0)).toBe(4250);
  expect(pollingDelay(1, 3000, 0, 1)).toBe(5750);
  expect(pollingDelay(1, 3000, 120_000, 0.5)).toBe(120_000);
});
test("focus and visibility cannot override Retry-After after a failed read", async () => {
  let reads = 0;
  const polling = new PagePolling(async () => { reads++; throw { retryAfterMs: 120_000 }; }, 10);
  try {
    polling.refresh(); await wait(5);
    polling.refresh(); polling.refresh(); polling.setVisible(false); polling.setVisible(true);
    await wait(20); expect(reads).toBe(1);
  } finally { polling.stop(); }
});
