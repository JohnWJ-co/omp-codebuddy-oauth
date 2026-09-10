// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/auth-flow.ts — 平移自 opencode-codebuddy-oauth，无平台依赖
import { fetchJson } from "./fetch-json.js";
import { AUTH_STATE_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, REFRESH_TIMEOUT_MS, PLATFORM } from "./config.js";

export function sleep(ms:number): Promise<void> { return new Promise(r=>setTimeout(r,ms)); }

export interface TokenPair {
  accessToken:string; refreshToken?:string; expiresIn?:number;
}

export async function requestAuthState(serverUrl:string): Promise<{ state:string; url:string }> {
  const url = `${serverUrl}/v2/plugin/auth/state?platform=${PLATFORM}&ioa=1`;
  const res = await fetchJson<{code:number; data?:{state:string; authUrl?:string}}>(url, {
    method:"POST",
    headers:{ Accept:"application/json", "Content-Type":"application/json", "X-No-Authorization":"true", "X-No-User-Id":"true", "X-No-Enterprise-Id":"true", "X-No-Department-Info":"true" },
    timeoutMs: AUTH_STATE_TIMEOUT_MS,
  });
  if (!res.ok || res.data.code !== 0 || !res.data.data?.state) throw new Error(`Auth state failed: ${JSON.stringify(res)}`);
  const state = res.data.data.state;
  const authUrl = res.data.data.authUrl || `${serverUrl}/login?platform=${PLATFORM}&state=${state}&ioa=1`;
  return { state, url: authUrl };
}

export async function pollForToken(serverUrl:string, state:string, expiresAt:number, signal?:AbortSignal): Promise<TokenPair|null> {
  // 先查后睡：首次立即查，失败后 sleep 再查
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return null;
    const res = await fetchJson<{code:number; data?:{accessToken:string; refreshToken?:string; expiresIn?:number}}>(
      `${serverUrl}/v2/plugin/auth/token?state=${state}`,
      { method:"GET", headers:{ Accept:"application/json", "X-No-Authorization":"true", "X-No-User-Id":"true", "X-No-Enterprise-Id":"true", "X-No-Department-Info":"true" }, timeoutMs: POLL_TIMEOUT_MS, signal },
    );
    if (res.ok && res.data.code===0 && res.data.data?.accessToken) return res.data.data;
    if (signal?.aborted) return null;
    if (Date.now() >= expiresAt) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

export async function refreshAccessToken(refreshToken:string, serverUrl:string): Promise<TokenPair|null> {
  const res = await fetchJson<{code:number; data?:{accessToken:string; refreshToken?:string; expiresIn?:number}}>(
    `${serverUrl}/v2/plugin/auth/token/refresh`,
    { method:"POST", headers:{ "Content-Type":"application/json", Accept:"application/json", Authorization:`Bearer ${refreshToken}` }, timeoutMs: REFRESH_TIMEOUT_MS },
  );
  if (!res.ok || res.data.code !== 0) return null;
  return res.data.data ?? null;
}
