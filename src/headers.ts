// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/headers.ts
import type { CodeBuddyConfig } from "./config.js";
import type { LRUMap } from "./lru.js";

function generateTraceId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // crypto 整体缺失（Node <19 无 flag 的 npm 安装路径）：Math.random 兜底，保证不崩
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function getOrCreateConversationId(lru: LRUMap<string,string>, sessionId: string | undefined, stable: boolean): string {
  if (!stable || !sessionId) return generateTraceId();
  const hit = lru.get(sessionId);
  if (hit) return hit;
  const id = generateTraceId();
  lru.set(sessionId, id);
  return id;
}
export function resolveModel(input: string | undefined, cfg: CodeBuddyConfig): string {
  return cfg.model ? cfg.model : (input ?? "");
}
const baseHeadersCache = new Map<string, Record<string,string>>();
export function baseHeaders(cfg: CodeBuddyConfig, domain: string): Record<string,string> {
  const cached = baseHeadersCache.get(domain);
  if (cached) return cached;
  const headers: Record<string,string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-Agent-Intent": cfg.agentIntent,
    "X-IDE-Type": cfg.ideType,
    "X-IDE-Name": cfg.ideName,
    "X-IDE-Version": cfg.ideVersion,
    "X-Product-Version": cfg.appVersion,
    "X-Env-ID": cfg.envId,
    "X-Domain": domain,
    "X-Product": cfg.product,
    "User-Agent": `${cfg.ideName}/${cfg.ideVersion} CodeBuddy/${cfg.appVersion}`,
  };
  baseHeadersCache.set(domain, headers);
  return headers;
}
export function buildRequestHeaders(
  sessionId: string | undefined,
  modelId: string | undefined,
  deps: { cfg: CodeBuddyConfig; server: { url: string; domain: string }; lru: LRUMap<string,string> },
): Record<string,string> {
  const { cfg, server, lru } = deps;
  const conversationId = getOrCreateConversationId(lru, sessionId, cfg.stableConversationId);
  const messageId = generateTraceId();
  const traceId = generateTraceId();
  const spanId = traceId.slice(0, 16);
  const parentSpanId = traceId.slice(16, 32);
  const base = baseHeaders(cfg, server.domain);
  const headers: Record<string,string> = {
    ...base,
    "X-Request-ID": messageId,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": messageId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-Trace-Id": traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",
  };
  const resolved = resolveModel(modelId, cfg);
  if (resolved) headers["X-Model-ID"] = resolved;
  return headers;
}
export function buildAuthHeaders(
  auth: { type: "api"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number },
  identity: { tenantId: string; enterpriseId: string; userId: string },
): Record<string,string> {
  if (auth.type === "api") {
    // D9: 双头保留，服务端校验头未知，生产双头在用，盲删 401
    return { Authorization: `Bearer ${auth.key}`, "X-API-Key": auth.key };
  }
  const h: Record<string,string> = { Authorization: `Bearer ${auth.access}` };
  if (identity.tenantId) h["X-Tenant-Id"] = identity.tenantId;
  if (identity.enterpriseId) h["X-Enterprise-Id"] = identity.enterpriseId;
  if (identity.userId) h["X-User-Id"] = identity.userId;
  return h;
}