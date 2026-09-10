import { describe, it, expect } from "vitest";
import { remoteModelToPi, DEFAULT_MODEL } from "../src/models.js";
import type { RemoteModel } from "../src/models.js";

describe("models (pi)", () => {
  it("remoteModelToPi 基本字段映射", () => {
    const m: RemoteModel = {
      id: "claude-x", name: "Claude X",
      maxInputTokens: 200000, maxOutputTokens: 32000,
      supportsToolCall: true, supportsImages: true,
      supportsReasoning: true,
      reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high"] },
    };
    const p = remoteModelToPi(m);
    expect(p.id).toBe("claude-x");
    expect(p.name).toBe("Claude X");
    expect(p.contextWindow).toBe(200000);
    expect(p.maxTokens).toBe(32000);
    expect(p.reasoning).toBe(true);
    expect(p.input).toEqual(["text", "image"]);
    expect(p.thinkingLevelMap).toEqual({ low: "low", high: "high", default: "high" });
    expect(p.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
  it("maxAllowedSize 优先于 maxInputTokens", () => {
    const p = remoteModelToPi({ id: "a", name: "A", maxAllowedSize: 256000, maxInputTokens: 128000 });
    expect(p.contextWindow).toBe(256000);
  });
  it("缺省尺寸走 DEFAULT", () => {
    const p = remoteModelToPi({ id: "a", name: "A" });
    expect(p.contextWindow).toBe(131_072);
    expect(p.maxTokens).toBe(8192);
  });
  it("disabledMultimodal 关闭图片输入", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsImages: true, disabledMultimodal: true });
    expect(p.input).toEqual(["text"]);
  });
  it("非推理模型无 thinkingLevelMap", () => {
    const p = remoteModelToPi({ id: "plain", name: "P", supportsReasoning: false });
    expect(p.reasoning).toBe(false);
    expect(p.thinkingLevelMap).toBeUndefined();
  });
  it("DEFAULT_MODEL 具备最小可用字段", () => {
    const p = remoteModelToPi(DEFAULT_MODEL);
    expect(p.id).toBe("auto");
    expect(p.contextWindow).toBe(168000);
    expect(p.maxTokens).toBe(32000);
  });
});
