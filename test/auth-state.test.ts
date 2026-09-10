import { describe, it, expect } from "vitest";
import { parseStoredAuth, pickAuthMode, effectiveAuth, needsRefresh } from "../src/auth-state.js";

describe("parseStoredAuth 窄化守卫", () => {
  it("损坏输入返回 undefined（非对象/缺字段/类型错）", () => {
    expect(parseStoredAuth(null)).toBeUndefined();
    expect(parseStoredAuth("bad")).toBeUndefined();
    expect(parseStoredAuth({ type:"api" })).toBeUndefined(); // 缺 key
    expect(parseStoredAuth({ type:"oauth", access:"a" })).toBeUndefined(); // 缺 refresh/expires
    expect(parseStoredAuth({ type:"unknown", key:"k" })).toBeUndefined();
  });
  it("合法 api 解析", () => {
    expect(parseStoredAuth({ type:"api", key:"k" })).toEqual({ type:"api", key:"k" });
  });
  it("合法 oauth 解析", () => {
    expect(parseStoredAuth({ type:"oauth", access:"a", refresh:"r", expires: 123 })).toEqual({ type:"oauth", access:"a", refresh:"r", expires:123 });
  });
  it("过期 oauth 仍解析（有效性由 effectiveAuth ตัดสิน）", () => {
    expect(parseStoredAuth({ type:"oauth", access:"a", refresh:"r", expires: 0 })).toBeDefined();
  });
});

describe("pickAuthMode 全矩阵", () => {
  it("cfg.auth=api 强制 api", () => {
    expect(pickAuthMode({ auth:"api", apiKey:"" } as any, undefined)).toBe("api");
    expect(pickAuthMode({ auth:"api", apiKey:"" } as any, { type:"oauth", access:"a" } as any)).toBe("api");
  });
  it("cfg.auth=oauth 强制 oauth", () => {
    expect(pickAuthMode({ auth:"oauth", apiKey:"ck_xxx" } as any, undefined)).toBe("oauth");
  });
  it("auto 时 apiKey 优先", () => {
    expect(pickAuthMode({ auth:"auto", apiKey:"ck_xxx" } as any, undefined)).toBe("api");
  });
  it("auto 时 stored api 优先", () => {
    expect(pickAuthMode({ auth:"auto", apiKey:"" } as any, { type:"api", key:"k" } as any)).toBe("api");
  });
  it("auto 时默认 oauth", () => {
    expect(pickAuthMode({ auth:"auto", apiKey:"" } as any, undefined)).toBe("oauth");
    expect(pickAuthMode({ auth:"auto", apiKey:"" } as any, { type:"oauth", access:"a", refresh:"r", expires: 999 } as any)).toBe("oauth");
  });
});

describe("effectiveAuth 单分支", () => {
  it("api 模式：cfg.apiKey 优先", () => {
    const cfg = { auth:"api", apiKey:"cfg-key" } as any;
    expect(effectiveAuth({ type:"api", key:"stored" } as any, cfg)).toEqual({ type:"api", key:"cfg-key" });
  });
  it("api 模式：无 cfg 时用 stored", () => {
    const cfg = { auth:"api", apiKey:"" } as any;
    expect(effectiveAuth({ type:"api", key:"stored" } as any, cfg)).toEqual({ type:"api", key:"stored" });
  });
  it("A2：api 模式无 key 返回 null（由上层 warn，非静默 fallback）", () => {
    const cfg = { auth:"api", apiKey:"" } as any;
    expect(effectiveAuth(undefined, cfg)).toBeNull();
    expect(effectiveAuth({ type:"oauth", access:"a", refresh:"r", expires: Date.now()+10000 } as any, cfg)).toBeNull();
  });
  it("oauth 单分支：未过期返回", () => {
    const cfg = { auth:"oauth", apiKey:"" } as any;
    const stored = { type:"oauth", access:"a", refresh:"r", expires: Date.now()+100000 };
    expect(effectiveAuth(stored as any, cfg)).toEqual({ type:"oauth", access:"a", refresh:"r", expires: stored.expires });
  });
  it("oauth 单分支：过期 token 仍返回（expires 校验删除，靠 401 刷新兜底）", () => {
    const cfg = { auth:"oauth", apiKey:"" } as any;
    const stored = { type:"oauth", access:"a", refresh:"r", expires: Date.now()-1000 };
    const res = effectiveAuth(stored as any, cfg);
    expect(res).not.toBeNull();
    expect((res as any).access).toBe("a");
  });
  it("oauth 缺 access 返回 null", () => {
    const cfg = { auth:"oauth", apiKey:"" } as any;
    expect(effectiveAuth({ type:"oauth", refresh:"r", expires: 123 } as any, cfg)).toBeNull();
  });
});

describe("needsRefresh 边界", () => {
  it("oauth 且 expires - skew < now 且 refresh 非空 → true", () => {
    const now = Date.now();
    const auth = { type:"oauth", access:"a", refresh:"r", expires: now + 4*60*1000 } as any; // 4min 内过期，skew 5min
    expect(needsRefresh(auth, now)).toBe(true);
  });
  it("oauth 但 expir 远未到 → false", () => {
    const now = Date.now();
    const auth = { type:"oauth", access:"a", refresh:"r", expires: now + 10*60*1000 } as any;
    expect(needsRefresh(auth, now)).toBe(false);
  });
  it("恰在 skew 边界外 → false", () => {
    const now = Date.now();
    const auth = { type:"oauth", access:"a", refresh:"r", expires: now + 5*60*1000 + 1000 } as any;
    expect(needsRefresh(auth, now)).toBe(false);
  });
  it("api 类型永不刷新", () => {
    expect(needsRefresh({ type:"api", key:"k" } as any, Date.now())).toBe(false);
  });
  it("oauth 但 refresh 为空 → false", () => {
    const auth = { type:"oauth", access:"a", refresh:"", expires: Date.now() } as any;
    expect(needsRefresh(auth, Date.now())).toBe(false);
  });
});