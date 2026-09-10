// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/jwt.ts
export interface JwtPayload {
  iss?: string; tenant_id?: string; tenantId?: string;
  enterprise_id?: string; enterpriseId?: string; ent_id?: string; entId?: string;
  user_id?: string; userId?: string; uid?: string; sub?: string;
  realm_access?: { roles?: string[] }; resource_access?: { account?: { roles?: string[] } };
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JwtPayload;
  } catch { return null; }
}

export function resolveIdentity(
  payload: JwtPayload | null,
  cfg?: { tenantId?: string; enterpriseId?: string; userId?: string },
): { tenantId: string; enterpriseId: string; userId: string } {
  if (!payload) return { tenantId: cfg?.tenantId ?? "", enterpriseId: cfg?.enterpriseId ?? "", userId: cfg?.userId ?? "" };
  // tenant：cfg 短路 > tenant_id/tenantId > iss 末尾 sso-（$ 锚）
  let tenantId = cfg?.tenantId ?? "";
  if (!tenantId) {
    if (payload.tenant_id) tenantId = payload.tenant_id;
    else if (payload.tenantId) tenantId = payload.tenantId;
    else {
      const m = (payload.iss ?? "").match(/realms\/sso-([^/]+)$/);
      if (m?.[1]) tenantId = m[1];
    }
  }
  // enterprise：cfg 短路 > roles 中 group-admin:* > enterprise_id 变体
  let enterpriseId = cfg?.enterpriseId ?? "";
  if (!enterpriseId) {
    const roles = payload.realm_access?.roles ?? payload.resource_access?.account?.roles;
    if (roles) { for (const r of roles) { const m = r.match(/group-admin:([A-Za-z0-9-]+)/); if (m?.[1]) { enterpriseId = m[1]; break; } } }
    if (!enterpriseId) enterpriseId = payload.enterprise_id ?? payload.enterpriseId ?? payload.ent_id ?? payload.entId ?? "";
  }
  // user：cfg 短路 > user_id 变体
  let userId = cfg?.userId ?? "";
  if (!userId) userId = payload.user_id ?? payload.userId ?? payload.uid ?? payload.sub ?? "";
  return { tenantId, enterpriseId, userId };
}