// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/auth-state.ts
import { REFRESH_SKEW_MS } from "./config.js";
import type { CodeBuddyConfig } from "./config.js";

export type AuthState = { type:"api"; key:string } | { type:"oauth"; access:string; refresh:string; expires:number };

export function parseStoredAuth(raw: unknown): AuthState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string,unknown>;
  if (o.type === "api" && typeof o.key === "string" && o.key.length > 0) return { type:"api", key: o.key };
  if (o.type === "oauth" && typeof o.access === "string" && o.access.length > 0 && typeof o.refresh === "string" && typeof o.expires === "number") {
    return { type:"oauth", access: o.access, refresh: o.refresh, expires: o.expires };
  }
  return undefined;
}

export function pickAuthMode(cfg: Pick<CodeBuddyConfig,"auth"|"apiKey">, stored: AuthState | undefined): "oauth"|"api" {
  if (cfg.auth === "api") return "api";
  if (cfg.auth === "oauth") return "oauth";
  if (cfg.apiKey) return "api";
  if (stored?.type === "api" && stored.key) return "api";
  return "oauth";
}

export function effectiveAuth(stored: AuthState | undefined, cfg: Pick<CodeBuddyConfig,"auth"|"apiKey">): AuthState | null {
  const mode = pickAuthMode(cfg, stored);
  if (mode === "api") {
    if (cfg.apiKey) return { type:"api", key: cfg.apiKey };
    if (stored?.type === "api" && stored.key) return { type:"api", key: stored.key };
    return null;
  }
  // oauth 单分支：expires 校验删除，过期仍返回，靠 401 兜底
  if (stored?.type === "oauth" && stored.access) {
    return { type:"oauth", access: stored.access, refresh: stored.refresh ?? "", expires: stored.expires ?? 0 };
  }
  return null;
}

export function needsRefresh(auth: AuthState, now: number): boolean {
  return auth.type === "oauth" && !!auth.refresh && (auth.expires - REFRESH_SKEW_MS) < now;
}