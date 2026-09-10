import { describe, it, expect } from "vitest";
import { LRUMap } from "../src/lru.js";

describe("LRUMap", () => {
  it("淘汰最久未用", () => {
    const m = new LRUMap<string,number>(2);
    m.set("a",1); m.set("b",2); m.set("c",3);
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe(2);
  });
  it("命中提升", () => {
    const m = new LRUMap<string,number>(2);
    m.set("a",1); m.set("b",2); m.get("a"); m.set("c",3);
    expect(m.get("b")).toBeUndefined();
    expect(m.get("a")).toBe(1);
  });
  it("max<=0 退化单条：set A、set B 后 get A 为 undefined、get B 命中", () => {
    const m = new LRUMap<string,number>(0);
    m.set("a",1); m.set("b",2);
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe(2);
    expect(m.size).toBe(1);
  });
  it("max=0 与 max=1 行为等价均为单条", () => {
    const m0 = new LRUMap<string,number>(0);
    const m1 = new LRUMap<string,number>(1);
    m0.set("a",1); m0.set("b",2);
    m1.set("a",1); m1.set("b",2);
    expect(m0.size).toBe(1);
    expect(m1.size).toBe(1);
  });
  it("delete/clear/size（供 session.compacted/deleted 清 LRU）", () => {
    const m = new LRUMap<string,number>(3);
    m.set("a",1); m.set("b",2);
    expect(m.delete("a")).toBe(true);
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(1);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.get("b")).toBeUndefined();
  });
  it("delete 不存在返回 false", () => {
    const m = new LRUMap<string,number>(2);
    expect(m.delete("missing")).toBe(false);
  });
});