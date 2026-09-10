import { describe, it, expect, vi } from "vitest";
import { createAuthFetch } from "../src/auth-fetch.js";
import type { AuthFetchDeps } from "../src/auth-fetch.js";
import { AccountPool } from "../src/accounts.js";

function makeDeps(overrides: Partial<AuthFetchDeps> = {}): AuthFetchDeps {
  return {
    getAuth: async () => ({ type: "api", key: "k" }),
    server: { url: "https://x", domain: "d" },
    buildAuthHeaders: () => ({}),
    resolveIdentity: () => ({ tenantId: "", enterpriseId: "", userId: "" }),
    decodeJwtPayload: () => null,
    refreshAndPersist: async () => null,
    cfg: {} as any,
    getPool: () => new AccountPool({ filePath: "/tmp/auth-fetch-test-accounts.json", strategy: "failover", cooldownMs: 0, logger: undefined }),
    maxAccountRetries: 0,
    chatCompletionsPath: "/v2/chat/completions",
    ...overrides,
  };
}

describe("auth-fetch (pi)", () => {
  it("非 chat/completions 透传", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok"));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    await af("https://x/other", { method: "GET" });
    expect(spy).toHaveBeenCalled();
  });
  it("!body 400", async () => {
    const af = createAuthFetch(makeDeps());
    const res = await af("https://x/v2/chat/completions", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing request body" });
  });
  it("未认证返回 401 + /login 指引", async () => {
    const af = createAuthFetch(makeDeps({ getAuth: async () => null }));
    const res = await af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toMatch(/\/login/);
  });
  it("!ok 透传并保留 Content-Type: application/json", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("bad", { status: 500, headers: { "Content-Type": "text/plain" } }));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    const res = await af("https://x/v2/chat/completions", { method: "POST", body: JSON.stringify({ stream: true }) });
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
  it("signal 透传至 doRequest", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    const ac = new AbortController();
    await af("https://x/v2/chat/completions", { method: "POST", body: "{}", signal: ac.signal });
    expect(spy.mock.calls[0][1].signal).toBe(ac.signal);
  });
  it("stream:true 缺 stream_options 注入 {include_usage:true}", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    await af("https://x/v2/chat/completions", { method: "POST", body: JSON.stringify({ stream: true, messages: [] }) });
    const sent = JSON.parse(spy.mock.calls[0][1].body);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });
  it("已含 stream_options 不覆写", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    await af("https://x/v2/chat/completions", { method: "POST", body: JSON.stringify({ stream: true, stream_options: { include_usage: false } }) });
    const sent = JSON.parse(spy.mock.calls[0][1].body);
    expect(sent.stream_options).toEqual({ include_usage: false });
  });
  it("非流式原样透传（不注入 stream_options）", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    await af("https://x/v2/chat/completions", { method: "POST", body: JSON.stringify({ stream: false, messages: [] }) });
    const sent = JSON.parse(spy.mock.calls[0][1].body);
    expect(sent).toEqual({ stream: false, messages: [] });
  });
  it("请求路径用 chatCompletionsPath 而非硬拼", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any, chatCompletionsPath: "/custom/path" }));
    await af("https://x/custom/path", { method: "POST", body: "{}" });
    expect(spy.mock.calls[0][0]).toBe("https://x/custom/path");
  });
  it("oauth 401 → refreshAndPersist 成功 → 重试一次", async () => {
    const responses = [
      new Response("unauth", { status: 401 }),
      new Response("ok", { status: 200 }),
    ];
    const spy = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    const refreshAndPersist = vi.fn().mockResolvedValue({ type: "oauth", access: "new", refresh: "r", expires: Date.now() + 60000 });
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type: "oauth", access: "old", refresh: "r", expires: 0 }),
      refreshAndPersist,
      fetchImpl: spy as any,
    }));
    const res = await af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(refreshAndPersist).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("oauth 401 → refresh 失败 → 原样返回 401", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("unauth", { status: 401 }));
    const refreshAndPersist = vi.fn().mockResolvedValue(null);
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type: "oauth", access: "old", refresh: "r", expires: 0 }),
      refreshAndPersist,
      fetchImpl: spy as any,
    }));
    const res = await af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("api 模式 401 不触发刷新", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("unauth", { status: 401 }));
    const refreshAndPersist = vi.fn();
    const af = createAuthFetch(makeDeps({ getAuth: async () => ({ type: "api", key: "k" }), refreshAndPersist, fetchImpl: spy as any }));
    const res = await af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(refreshAndPersist).not.toHaveBeenCalled();
  });
  it("11133 瞬时 400 → 退避重试成功（缩短退避验证逻辑）", async () => {
    const responses = [
      new Response(JSON.stringify({ code: 11133 }), { status: 400 }),
      new Response("ok", { status: 200 }),
    ];
    const spy = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    // 用 fake timers 加速退避
    vi.useFakeTimers();
    const p = af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    await vi.runAllTimersAsync();
    const res = await p;
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("非 11133 的 400 不重试，原样透传", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 11101, msg: "invalid" }), { status: 400 }));
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }));
    const res = await af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.code).toBe(11101);
  });
  it("认证头注入（api 双头）", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type: "api", key: "ck_test" }),
      buildAuthHeaders: (auth) => ({ Authorization: `Bearer ${(auth as any).key}`, "X-API-Key": (auth as any).key }),
      fetchImpl: spy as any,
    }));
    await af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    const headers = spy.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer ck_test");
    expect(headers.get("X-API-Key")).toBe("ck_test");
  });
  it("oauth 认证头注入（身份头来自 JWT）", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const af = createAuthFetch(makeDeps({
      getAuth: async () => ({ type: "oauth", access: "tok", refresh: "r", expires: 0 }),
      resolveIdentity: () => ({ tenantId: "t1", enterpriseId: "e1", userId: "u1" }),
      buildAuthHeaders: (auth, identity) => ({
        Authorization: `Bearer ${(auth as any).access}`,
        ...(identity.tenantId ? { "X-Tenant-Id": identity.tenantId } : {}),
        ...(identity.enterpriseId ? { "X-Enterprise-Id": identity.enterpriseId } : {}),
        ...(identity.userId ? { "X-User-Id": identity.userId } : {}),
      }),
      fetchImpl: spy as any,
    }));
    await af("https://x/v2/chat/completions", { method: "POST", body: "{}" });
    const headers = spy.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("X-Tenant-Id")).toBe("t1");
    expect(headers.get("X-Enterprise-Id")).toBe("e1");
    expect(headers.get("X-User-Id")).toBe("u1");
  });
});
