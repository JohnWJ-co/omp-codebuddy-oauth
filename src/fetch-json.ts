// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/fetch-json.ts 关键结构
function withTimeout(ms: number, external?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, cancel: () => { clearTimeout(timer); external?.removeEventListener("abort", onAbort); } };
}
export async function fetchJson<T>(url: string, opts: { method?: string; headers?: Record<string,string>; body?: string; timeoutMs: number; signal?: AbortSignal }) {
  const t = withTimeout(opts.timeoutMs, opts.signal);
  if (t.signal.aborted) {
    t.cancel();
    return { ok: false as const, text: "timeout or abort" };
  }
  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    const handler = () => reject(new DOMException("aborted", "AbortError"));
    abortListener = handler;
    t.signal.addEventListener("abort", handler, { once: true });
  });
  try {
    const res = await Promise.race([
      fetch(url, { method: opts.method, headers: opts.headers, body: opts.body, signal: t.signal }),
      abortPromise,
    ]);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      return { ok: false as const, status: res.status, text };
    }
    const data = await res.json() as T;
    return { ok: true as const, data };
  } catch (e) {
    const err = e as Error;
    const isAbort = err?.name === "AbortError" || err?.message === "aborted";
    return { ok: false as const, text: isAbort ? "timeout or abort" : (err?.message || "fetch failed") };
  } finally {
    if (abortListener) t.signal.removeEventListener("abort", abortListener);
    t.cancel();
  }
}