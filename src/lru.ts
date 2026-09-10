// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
export class LRUMap<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: K, v: V): void {
    if (this.max <= 0) { this.map.clear(); this.map.set(k, v); return; }
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first as K);
    }
    this.map.set(k, v);
  }
  delete(k: K): boolean { return this.map.delete(k); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}