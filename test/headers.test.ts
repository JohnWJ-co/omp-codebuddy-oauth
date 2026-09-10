import { describe, it, expect } from "vitest";
import { baseHeaders, buildRequestHeaders, buildAuthHeaders, resolveModel } from "../src/headers.js";
import { LRUMap } from "../src/lru.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const cfg: any = {
    platform: "VSCode", appVersion: "4.9.29177644", ideName: "VSCode", ideType: "VSCode",
    ideVersion: "1.119.0", product: "SaaS", agentIntent: "craft", envId: "production",
    model: "", stableConversationId: true, conversationMapMax: 100, ...overrides,
  };
  const server = { url: "https://copilot.tencent.com", domain: "www.codebuddy.cn" };
  const lru = new LRUMap<string, string>(100);
  return { cfg, server, lru };
}

describe("headers", () => {
  it("baseHeaders 12 头", () => {
    const h = baseHeaders(makeDeps().cfg, "www.codebuddy.cn");
    expect(h["X-Agent-Intent"]).toBe("craft");
    expect(h["X-Domain"]).toBe("www.codebuddy.cn");
    expect(h["X-Product"]).toBe("SaaS");
  });
  it("X-Conversation-ID 用 conversationId 而非 messageId", () => {
    const deps = makeDeps();
    const h = buildRequestHeaders("sess-1", "m1", deps);
    expect(h["X-Conversation-ID"]).not.toBe(h["X-Request-ID"]);
    expect(h["X-Conversation-ID"]).toBe(deps.lru.get("sess-1"));
  });
  it("b3 合法：trace 32hex，span!=parent 各16hex", () => {
    const h = buildRequestHeaders("s", undefined, makeDeps());
    const [trace, span, sampled, parent] = h["b3"].split("-");
    expect(trace).toMatch(/^[0-9a-f]{32}$/);
    expect(span).toMatch(/^[0-9a-f]{16}$/);
    expect(parent).toMatch(/^[0-9a-f]{16}$/);
    expect(span).not.toBe(parent);
    expect(sampled).toBe("1");
  });
  it("resolveModel 优先 cfg.model", () => {
    expect(resolveModel("input", { model: "cfg-model" } as any)).toBe("cfg-model");
    expect(resolveModel("input", { model: "" } as any)).toBe("input");
  });
  it("X-Model-ID 仅非空注入", () => {
    const deps = makeDeps({ model: "" });
    expect(buildRequestHeaders("s", "", deps)["X-Model-ID"]).toBeUndefined();
    expect(buildRequestHeaders("s", "m1", deps)["X-Model-ID"]).toBe("m1");
  });
  it("api 双头保留", () => {
    const h = buildAuthHeaders({ type:"api", key:"k" } as any, { tenantId:"", enterpriseId:"", userId:"" });
    expect(h["Authorization"]).toBe("Bearer k");
    expect(h["X-API-Key"]).toBe("k");
  });
  it("22 头全量快照（不含 X-Model-ID）", () => {
    const h = buildRequestHeaders("s", "", makeDeps({ model: "" }));
    expect(Object.keys(h).sort()).toEqual([
      "Accept", "Content-Type", "User-Agent", "X-Agent-Intent", "X-B3-ParentSpanId",
      "X-B3-Sampled", "X-B3-SpanId", "X-B3-TraceId", "X-Conversation-ID",
      "X-Conversation-Message-ID", "X-Conversation-Request-ID", "X-Domain", "X-Env-ID",
      "X-IDE-Name", "X-IDE-Type", "X-IDE-Version", "X-Product", "X-Product-Version",
      "X-Request-ID", "X-Request-Trace-Id", "X-Requested-With", "b3",
    ]);
  });
  it("oauth 条件注入 X-Tenant-Id/X-Enterprise-Id/X-User-Id", () => {
    const h = buildAuthHeaders({ type:"oauth", access:"a", refresh:"r", expires:1 } as any, { tenantId:"t", enterpriseId:"e", userId:"u" });
    expect(h["X-Tenant-Id"]).toBe("t");
    expect(h["X-Enterprise-Id"]).toBe("e");
    expect(h["X-User-Id"]).toBe("u");
    const empty = buildAuthHeaders({ type:"oauth", access:"a", refresh:"r", expires:1 } as any, { tenantId:"", enterpriseId:"", userId:"" });
    expect(empty["X-Tenant-Id"]).toBeUndefined();
    expect(empty["X-Enterprise-Id"]).toBeUndefined();
    expect(empty["X-User-Id"]).toBeUndefined();
  });
});