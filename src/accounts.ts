// src/accounts.ts — 多 CodeBuddy 账号池：加载/保存、按策略选号、429 短冷却、认证失效标记、旧快照迁移。
// 状态语义：status=ok + cooldownUntil>now → 「冷却中」（429/401 抖动，时间到自动恢复）；
//           status=invalid → 「认证失效」（刷新失败等），调度永久跳过，重新登录（append / 用户重新 /login）后恢复。
// 无 primary 槽位：所有账号统一追加命名（账号 1 / 账号 2 …），登录按 userId 去重。
import * as fs from "fs/promises";
import { dirname } from "path";
import type { Logger } from "./log.js";

export type AccountStatus = "ok" | "invalid";

export interface AccountRecord {
  id: string;
  name: string;
  type: "oauth";
  /** 账号身份（JWT user_id/uid/sub，用于登录去重；旧迁移账号可能为空） */
  userId?: string;
  access: string;
  refresh: string;
  expires: number;
  status: AccountStatus;
  invalidReason?: string;
  cooldownUntil?: number;
}

export interface AccountPick {
  id: string;
  auth: { type: "oauth"; access: string; refresh: string; expires: number };
}

export interface AccountPoolOptions {
  filePath: string;
  strategy: "round-robin" | "failover";
  cooldownMs: number;
  logger?: Logger;
  onInvalid?: (accountId: string, reason: string) => void;
}

interface AccountsFileShape {
  cursor?: number;
  accounts?: AccountRecord[];
}

export class AccountPool {
  private accounts: AccountRecord[] = [];
  private cursor = 0;
  private notifiedInvalid = new Set<string>();
  private readonly opts: AccountPoolOptions;

  constructor(opts: AccountPoolOptions) {
    this.opts = opts;
  }

  size(): number {
    return this.accounts.length;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.opts.filePath, "utf8");
      const o = JSON.parse(raw) as AccountsFileShape;
      if (Array.isArray(o.accounts)) {
        this.accounts = o.accounts.filter(
          (a): a is AccountRecord =>
            !!a && typeof a === "object" && typeof a.id === "string" && typeof a.access === "string" && a.access.length > 0,
        );
        for (const a of this.accounts) {
          a.type = "oauth";
          a.status = a.status === "invalid" ? "invalid" : "ok";
        }
      } else {
        this.accounts = [];
      }
      this.cursor = Number.isInteger(o.cursor) && (o.cursor as number) >= 0 ? (o.cursor as number) : 0;
    } catch {
      this.accounts = [];
      this.cursor = 0;
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.opts.filePath), { recursive: true });
      const payload = JSON.stringify({ cursor: this.cursor, accounts: this.accounts }, null, 2);
      await fs.writeFile(this.opts.filePath, payload, { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      this.opts.logger?.error(`accounts save failed: ${(e as Error).message}`);
    }
  }

  private find(id: string): AccountRecord | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  findByAccess(access: string): AccountRecord | undefined {
    return this.accounts.find((a) => a.access === access);
  }

  findByUserId(userId: string): AccountRecord | undefined {
    return this.accounts.find((a) => a.userId && a.userId === userId);
  }

  findByRefresh(refresh: string): AccountRecord | undefined {
    return this.accounts.find((a) => a.refresh && a.refresh === refresh);
  }

  /**
   * /login 登录成功后的账号归属：按 userId 去重，无 primary 槽位，全部走统一命名。
   * - 已有相同 userId 账号 → 更新该账号（token 轮换）；
   * - 存在无 userId 的旧账号 → 就地更新并补记 userId；
   * - 否则 → 追加为新账号（账号 N）。
   */
  async upsertByLogin(cred: { access: string; refresh?: string; expires?: number }, userId?: string): Promise<{ id: string; created: boolean }> {
    if (userId) {
      const hit = this.findByUserId(userId);
      if (hit) {
        await this.updateCred(hit.id, cred);
        return { id: hit.id, created: false };
      }
      const legacy = this.accounts.find((a) => !a.userId);
      if (legacy) {
        await this.updateCred(legacy.id, cred);
        legacy.userId = userId;
        await this.save();
        return { id: legacy.id, created: false };
      }
    } else {
      // 无法识别身份：就地更新第一个无 userId 账号，避免累加不明账号
      const legacy = this.accounts.find((a) => !a.userId);
      if (legacy) {
        await this.updateCred(legacy.id, cred);
        return { id: legacy.id, created: false };
      }
    }
    const rec = await this.append(cred, undefined, userId);
    return { id: rec.id, created: true };
  }

  inCooldown(acc: AccountRecord): boolean {
    return !!acc.cooldownUntil && acc.cooldownUntil > Date.now();
  }

  isAvailable(acc: AccountRecord): boolean {
    return acc.status !== "invalid" && !this.inCooldown(acc);
  }

  /** 状态视图（供 /codebuddy-accounts 展示） */
  list(): { id: string; name: string; status: "ok" | "cooldown" | "invalid"; cooldownRemainingMs: number; invalidReason?: string }[] {
    const now = Date.now();
    return this.accounts.map((a) => {
      if (a.status === "invalid") {
        return { id: a.id, name: a.name, status: "invalid" as const, cooldownRemainingMs: 0, invalidReason: a.invalidReason };
      }
      const cooling = !!a.cooldownUntil && a.cooldownUntil > now;
      return {
        id: a.id,
        name: a.name,
        status: cooling ? ("cooldown" as const) : ("ok" as const),
        cooldownRemainingMs: cooling ? a.cooldownUntil! - now : 0,
      };
    });
  }

  /** 添加账号（acct-N，N 从 1 递增），重置 status=ok；默认名「账号 N」 */
  async append(cred: { access: string; refresh?: string; expires?: number }, name?: string, userId?: string): Promise<AccountRecord> {
    let n = 1;
    while (this.find(`acct-${n}`)) n++;
    const rec: AccountRecord = {
      id: `acct-${n}`,
      name: name?.trim() || `账号 ${n}`,
      type: "oauth",
      access: cred.access,
      refresh: cred.refresh ?? "",
      expires: cred.expires ?? 0,
      status: "ok",
      ...(userId ? { userId } : {}),
    };
    this.accounts.push(rec);
    await this.save();
    return rec;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length !== before) {
      await this.save();
      return true;
    }
    return false;
  }

  /** 刷新成功后回写指定账号凭据并重置状态 */
  async updateCred(id: string, cred: { access: string; refresh?: string; expires?: number }): Promise<void> {
    const a = this.find(id);
    if (!a) return;
    a.access = cred.access;
    a.refresh = cred.refresh ?? "";
    a.expires = cred.expires ?? 0;
    a.status = "ok";
    a.invalidReason = undefined;
    a.cooldownUntil = undefined;
    await this.save();
  }

  /** 选号：跳过 invalid 与冷却中；全部不可用则回退主账号（仍尝试一次） */
  next(tried: Set<string> = new Set()): AccountPick | null {
    const candidates = this.orderedCandidates(tried);
    for (const a of candidates) {
      if (tried.has(a.id)) continue;
      if (this.isAvailable(a)) {
        this.cursor = this.accounts.indexOf(a);
        return this.toPick(a);
      }
    }
    const first = this.accounts.find((a) => !tried.has(a.id));
    if (first) return this.toPick(first);
    return null;
  }

  private orderedCandidates(tried: Set<string>): AccountRecord[] {
    if (this.opts.strategy === "failover") {
      return [...this.accounts];
    }
    if (this.accounts.length === 0) return [];
    const start = (this.cursor + 1) % this.accounts.length;
    return [...this.accounts.slice(start), ...this.accounts.slice(0, start)];
  }

  private toPick(a: AccountRecord): AccountPick {
    return { id: a.id, auth: { type: "oauth", access: a.access, refresh: a.refresh ?? "", expires: a.expires ?? 0 } };
  }

  /** 429/401 短冷却（status 保持 ok，时间到自动恢复） */
  async markCooldown(id: string): Promise<void> {
    const a = this.find(id);
    if (!a) return;
    a.cooldownUntil = Date.now() + this.opts.cooldownMs;
    await this.save();
  }

  /** 认证失效（刷新失败等）：调度永久跳过 + 首次失效触发 onInvalid 重登提示 */
  async markInvalid(id: string, reason: string): Promise<void> {
    const a = this.find(id);
    if (!a) return;
    const first = !this.notifiedInvalid.has(id);
    a.status = "invalid";
    a.invalidReason = reason;
    a.cooldownUntil = undefined;
    if (first) {
      this.notifiedInvalid.add(id);
      if (this.opts.onInvalid) {
        try { this.opts.onInvalid(id, reason); } catch { this.opts.logger?.error(`onInvalid callback failed for ${id}`); }
      }
    }
    await this.save();
  }

}
