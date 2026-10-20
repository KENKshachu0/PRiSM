/**
 * A short command session on Home Assistant's WebSocket API, for the account
 * work its REST API cannot do (who the token belongs to, creating a read-only
 * user, minting a long-lived token).
 *
 * Workers open an outbound WebSocket through `fetch` with an Upgrade header;
 * the socket is closed as soon as the commands are done, so nothing stays open.
 */
export type HaSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: any) => void): void;
};

export type HaSocketFactory = (url: string) => Promise<HaSocket>;

export const workerHaSocket: HaSocketFactory = async (url) => {
  const response = await fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
  const socket = (response as Response & { webSocket?: (HaSocket & { accept(): void }) | null }).webSocket;
  if (!socket) throw new HaCommandError(`Home Assistant 没有接受 WebSocket 连接（HTTP ${response.status}）`);
  socket.accept();
  return socket;
};

export class HaCommandError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export const haWebSocketUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/websocket`;

export type HaSession = {
  command<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T>;
  close(): void;
};

/** Connect and authenticate. Rejects when the token is refused. */
export async function openHaSession(
  baseUrl: string,
  token: string,
  options: { open?: HaSocketFactory; timeoutMs?: number } = {},
): Promise<HaSession> {
  const socket = await (options.open ?? workerHaSocket)(haWebSocketUrl(baseUrl));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let authenticated: { resolve(): void; reject(error: Error): void } | null = null;
  let closed = false;
  const fail = (error: Error) => {
    authenticated?.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    let message: { type?: string; id?: number; success?: boolean; result?: unknown; error?: { code?: string; message?: string }; message?: string };
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
    else if (message.type === "auth_ok") authenticated?.resolve();
    else if (message.type === "auth_invalid") authenticated?.reject(new HaCommandError(message.message || "Home Assistant 拒绝了令牌", "auth_invalid"));
    else if (message.type === "result" && typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.success) waiter.resolve(message.result);
      else waiter.reject(new HaCommandError(message.error?.message || "Home Assistant 命令失败", message.error?.code));
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
    fail(new HaCommandError("Home Assistant 连接已断开"));
  });
  socket.addEventListener("error", () => fail(new HaCommandError("Home Assistant 连接出错")));

  const within = <T>(promise: Promise<T>, what: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new HaCommandError(`${what}超时`)), timeoutMs);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });

  try {
    await within(new Promise<void>((resolve, reject) => { authenticated = { resolve, reject }; }), "Home Assistant 认证");
  } catch (error) {
    socket.close();
    throw error;
  }
  let nextId = 1;
  return {
    command<T>(type: string, payload: Record<string, unknown> = {}) {
      if (closed) return Promise.reject(new HaCommandError("Home Assistant 连接已断开"));
      const id = nextId++;
      const result = new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      });
      socket.send(JSON.stringify({ id, type, ...payload }));
      return within(result, `Home Assistant ${type} `);
    },
    close() {
      if (!closed) socket.close(1000, "done");
      closed = true;
    },
  };
}
