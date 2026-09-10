import { describe, it, expect } from "vitest";
import { decodeJwtPayload, resolveIdentity } from "../src/jwt.js";

function b64(o: unknown) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function tok(p: unknown) { return `h.${b64(p)}.s`; }

describe("jwt", () => {
  it("畸形 token 返回 null", () => { expect(decodeJwtPayload("bad")).toBeNull(); });
  it("tenant 8变体", () => {
    expect(resolveIdentity({ iss: "https://x/realms/sso-abc123" } as any).tenantId).toBe("abc123");
    expect(resolveIdentity({ tenant_id: "t1" } as any).tenantId).toBe("t1");
  });
  it("iss 中段 sso- 不误匹配（$ 锚）", () => {
    expect(resolveIdentity({ iss: "https://x/realms/sso-abc/extra" } as any).tenantId).toBe("");
  });
  it("enterprise group-admin 遍历", () => {
    expect(resolveIdentity({ realm_access: { roles: ["group-admin:ent-1"] } } as any).enterpriseId).toBe("ent-1");
  });
  it("cfg 短路优先于 JWT", () => {
    expect(resolveIdentity({ tenant_id: "jwt" } as any, { tenantId: "cfg" } as any).tenantId).toBe("cfg");
  });
  it("decodeJwtPayload 正向 b64url→pad 解码", () => {
    expect(decodeJwtPayload(tok({ sub: "u1" }))).toEqual({ sub: "u1" });
    // b64url 长度 mod 4 ≠ 0 时补 pad 仍可解码
    expect(decodeJwtPayload(tok({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJwtPayload(tok({ tenant_id: "t1" }))).toEqual({ tenant_id: "t1" });
  });
  it("12 claim 全回退链", () => {
    // tenant 大小写变体
    expect(resolveIdentity({ tenant_id: "t1" } as any).tenantId).toBe("t1");
    expect(resolveIdentity({ tenantId: "T1" } as any).tenantId).toBe("T1");
    // enterprise 4 变体
    expect(resolveIdentity({ enterprise_id: "e1" } as any).enterpriseId).toBe("e1");
    expect(resolveIdentity({ enterpriseId: "E1" } as any).enterpriseId).toBe("E1");
    expect(resolveIdentity({ ent_id: "e2" } as any).enterpriseId).toBe("e2");
    expect(resolveIdentity({ entId: "E2" } as any).enterpriseId).toBe("E2");
    // user 4 变体
    expect(resolveIdentity({ user_id: "u1" } as any).userId).toBe("u1");
    expect(resolveIdentity({ userId: "U1" } as any).userId).toBe("U1");
    expect(resolveIdentity({ uid: "u2" } as any).userId).toBe("u2");
    expect(resolveIdentity({ sub: "s1" } as any).userId).toBe("s1");
    // roles 双源
    expect(resolveIdentity({ realm_access: { roles: ["group-admin:ent-r"] } } as any).enterpriseId).toBe("ent-r");
    expect(resolveIdentity({ resource_access: { account: { roles: ["group-admin:ent-a"] } } } as any).enterpriseId).toBe("ent-a");
  });
});