import { afterEach, expect, test } from "bun:test";
import { api, ApiError, playerOperation } from "./api";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("v1 client unwraps data and preserves actionable error codes", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ data: { value: 42 } }), { preconnect: originalFetch.preconnect });
  expect(await api("/api/v1/me")).toEqual({ value: 42 });
  globalThis.fetch = Object.assign(async () => Response.json({ error: { code: "LOCATION_REQUIRED", message: "需要定位" } }, { status: 403 }), { preconnect: originalFetch.preconnect });
  try { await api("/api/v1/me"); throw new Error("Expected an error"); } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("LOCATION_REQUIRED");
  }
});

test("a lost checkout response reuses its operation ID",async()=>{
  const storage=new Map<string,string>();
  const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
  const bodies:string[]=[];
  globalThis.fetch=Object.assign(async (_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));if(bodies.length===1)throw new Error("connection lost");return Response.json({data:{ok:true}});},{preconnect:originalFetch.preconnect});
  try{
    await expect(playerOperation("/api/v1/shops/test/player/checkout/confirm",{})).rejects.toThrow();
    expect(await playerOperation("/api/v1/shops/test/player/checkout/confirm",{})).toEqual({ok:true});
    expect(JSON.parse(bodies[0]!).operationId).toBe(JSON.parse(bodies[1]!).operationId);
    expect(storage.size).toBe(0);
  }finally{if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else Reflect.deleteProperty(globalThis,"sessionStorage");}
});


test("a failed device action never holds back the next one",async()=>{
  const storage=new Map<string,string>();
  const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
  const path="/api/v1/merchant/machines/m1/actions";
  const ids:string[]=[];
  let reply:"lost"|"failed"|"ok"="failed";
  globalThis.fetch=Object.assign(async (_url:unknown,init?:RequestInit)=>{
    ids.push(JSON.parse(String(init?.body)).operationId);
    if(reply==="lost")throw new TypeError("Failed to fetch");
    return reply==="ok"?Response.json({data:{ok:true}}):Response.json({error:{code:"DEVICE_UNAVAILABLE",message:"设备连接失败"}},{status:502});
  },{preconnect:originalFetch.preconnect});
  try{
    // The server answered: a retry is a new request, not a replay of the failure.
    await expect(playerOperation(path,{action:"aime.scan",accessCode:"1"})).rejects.toThrow("设备连接失败");
    expect(storage.size).toBe(0);
    reply="lost";
    await expect(playerOperation(path,{action:"aime.scan",accessCode:"1"})).rejects.toThrow();
    expect(storage.size).toBe(1);
    // No answer came back, yet a different action goes ahead.
    reply="ok";
    expect(await playerOperation(path,{action:"power.on"})).toEqual({ok:true});
    expect(new Set(ids).size).toBe(3);
    expect(storage.size).toBe(0);
  }finally{if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else Reflect.deleteProperty(globalThis,"sessionStorage");}
});

test("reads retry once on a lost connection; mutations never auto-retry", async () => {
  for (const [path, method, expected] of [
    ["/api/v1/shops/test/player/me", "GET", 2],
    ["/api/v1/shops/test/player/checkout/preview", "POST", 2],
    ["/api/v1/shops/test/player/checkout/confirm", "POST", 1],
    ["/api/v1/devices/session/actions", "POST", 1],
  ] as const) {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      if (++calls === 1) throw new TypeError("Failed to fetch");
      return Response.json({ data: { ok: true } });
    }, { preconnect: originalFetch.preconnect });
    if (expected === 2) expect(await api(path, { method })).toEqual({ ok: true });
    else await expect(api(path, { method })).rejects.toThrow("Failed to fetch");
    expect(calls).toBe(expected);
  }
});

test("insufficient balance is actionable and clears the rejected checkout without auto-retry", async () => {
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  const ids: string[] = [];
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    ids.push(JSON.parse(String(init?.body)).operationId);
    // As the server sends it: the player text in message and notice, the diagnostic in reason.
    return Response.json({ error: {
      code: "INSUFFICIENT_BALANCE", message: "余额不足，请充值后再结账，计费会继续", reason: "Insufficient currency holdings for this operation.",
      notice: { code: "INSUFFICIENT_BALANCE", level: "warning", display: "dialog", flow: "none", title: "余额不足", body: "余额不足，请充值后再结账，计费会继续", actions: [] },
      details: { required: 12 },
    } }, { status: 409 });
  }, { preconnect: originalFetch.preconnect });
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await playerOperation("/api/v1/shops/test/player/checkout/confirm", {});
        throw new Error("Expected insufficient balance");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const failure = error as ApiError;
        expect(failure.message).toBe("余额不足，请充值后再结账，计费会继续");
        expect(failure.notice?.display).toBe("dialog");
        expect(failure.code).toBe("INSUFFICIENT_BALANCE");
        expect(failure.status).toBe(409);
        expect(failure.details).toEqual({ required: 12 });
        expect(failure.sessionExpired).toBe(false);
      }
      expect(ids.length).toBe(attempt);
      expect(storage.size).toBe(0);
    }
    expect(ids[0]).not.toBe(ids[1]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
