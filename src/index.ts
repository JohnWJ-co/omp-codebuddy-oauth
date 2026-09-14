// src/index.ts — Pi 扩展入口：注册 codebuddy provider（HTTP 直连 /v2/chat/completions）
//
// 数据流：
//   Pi agent → modelRuntime.streamSimple（auth 解析 + before_provider_headers 合并）
//     → 本插件 streamSimple wrapper（注入 22 头 + 自定义 fetch）
//     → auth-fetch 拦截器（认证头注入 + 401/403 刷新重试 + 11133 瞬时 400 退避）
//     → ${server}/v2/chat/completions
//
// 与 opencode 版的对应关系：
//   opencode auth.loader.fetch  → SimpleStreamOptions.fetch（auth-fetch 拦截器）
//   opencode chat.headers       → wrapper 内 options.headers（provider 边界清晰，事件无 provider 信息）
//   opencode config（模型发现） → registerProvider.models + 登录/启动后主动发现重注册
//   opencode auth.methods       → registerProvider.oauth.login / refreshToken（Pi 原生 /login）
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { getConfig, resolveServerUrl, PROVIDER_ID, CHAT_COMPLETIONS_PATH, POLL_TOTAL_TIMEOUT_MS, DEFAULT_EXPIRES_MS, CONFIG_DIR_NAME } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { effectiveAuth, pickAuthMode } from "./auth-state.js";
import type { AuthState } from "./auth-state.js";
import { requestAuthState, pollForToken, refreshAccessToken } from "./auth-flow.js";
import { createAuthFetch } from "./auth-fetch.js";
import { AccountPool } from "./accounts.js";
import { createCodebuddyStreamSimple } from "./stream.js";
import { buildRequestHeaders, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { fetchRemoteModels, remoteModelToPi, DEFAULT_MODEL, DiscoveryCache, CODEBUDDY_COMPAT, type RemoteModel } from "./models.js";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

export default async function codebuddyExtension(pi: ExtensionAPI) {
  const cfg = getConfig();
  const server = resolveServerUrl(cfg);
  const logger = createLogger();
  const conversationIds = new LRUMap<string, string>(cfg.conversationMapMax);
  const discoveryCache = new DiscoveryCache({
    ttlMs: 5 * 60 * 1000,
    fetchFn: (token, signal) => fetchRemoteModels(token, server, signal),
  });

  // --- token 快照（~/.pi/agent/codebuddy-auth.json）---
  // Pi CredentialStore 不对扩展暴露读取接口；login/refresh 全部经过本扩展，
  // 顺手落一份独立快照供请求时读取。真实凭据源仍是 Pi auth.json（由 Pi 自动持久化）。
  const snapshotPath = join(homedir(), CONFIG_DIR_NAME || ".pi", "agent", "codebuddy-auth.json");
  const syncSnapshot: { value: OAuthCredentials | undefined } = { value: undefined };

  // --- 模型列表持久化兜底：一旦发现成功即存盘，启动/刷新优先用上次成功的列表 ---
  // 彻底杜绝「发现失败 → fallback [auto] 泄漏 → /models 只剩 auto」：只要历史上成功过，
  // provider 注册与 refreshModels 都从快照起步，任何时刻都不会退化成 auto-only。
  const modelsSnapshotPath = join(homedir(), CONFIG_DIR_NAME || ".pi", "agent", "codebuddy-models.json");
  async function loadModelsSnapshot(): Promise<any[]> {
    try {
      const raw = await fs.readFile(modelsSnapshotPath, "utf8");
      const arr = JSON.parse(raw) as RemoteModel[];
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch { /* 无快照或损坏 → 空 */ }
    return [];
  }
  async function saveModelsSnapshot(models: any[]): Promise<void> {
    try {
      await fs.mkdir(dirname(modelsSnapshotPath), { recursive: true });
      await fs.writeFile(modelsSnapshotPath, JSON.stringify(models, null, 2), { mode: 0o600 } as any);
    } catch { /* 快照写失败不影响主流程 */ }
  }

  async function loadSnapshot(): Promise<void> {
    try {
      const raw = await fs.readFile(snapshotPath, "utf8");
      const o = JSON.parse(raw) as Partial<OAuthCredentials>;
      if (typeof o.access === "string" && o.access) {
        syncSnapshot.value = { access: o.access, refresh: o.refresh ?? "", expires: o.expires ?? 0 };
      }
    } catch { /* 不存在或损坏 → 未登录 */ }
  }
  await loadSnapshot();

  // --- 多账号池（OAuth 多账号：负载均衡 / 故障转移）---
  let piUI: any = undefined;
  pi.on("session_start", (_event, ctx) => {
    piUI = ctx.ui;
  });
  const pool = new AccountPool({
    filePath: cfg.accountsFile,
    strategy: cfg.accountStrategy,
    cooldownMs: cfg.accountCooldownMs,
    logger,
    onInvalid: (id, reason) => notifyAccountInvalid(id, reason),
  });
  await pool.load();

  function notifyAccountInvalid(id: string, reason: string): void {
    const info = pool.list().find((a) => a.id === id);
    const name = info?.name ?? id;
    const msg = `codebuddy 账号「${name}」（id=${id}）认证失效：${reason}。请运行 /codebuddy-accounts add 重新登录（主账号用 /login codebuddy）`;
    if (piUI?.notify) piUI.notify(msg, "error");
    else logger.warn(msg);
  }

  async function persistSnapshot(cred: OAuthCredentials): Promise<void> {
    syncSnapshot.value = cred;
    try {
      await fs.mkdir(dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify(cred, null, 2), "utf8");
    } catch (e) {
      logger.error(`snapshot write failed: ${(e as Error).message}`);
    }
  }

  function credToAuthState(cred: OAuthCredentials | undefined): AuthState | undefined {
    if (!cred) return undefined;
    return { type: "oauth", access: cred.access, refresh: cred.refresh ?? "", expires: cred.expires ?? 0 };
  }

  // --- 刷新（auth-fetch 401 兜底用）：单飞 + 写快照 ---
  // Pi 原生 refreshToken 仅在 resolveStoredOAuth 过期路径触发；流中途 401 由这里兜底
  class RefreshLock {
    private inflight: Promise<AuthState | null> | null = null;
    run(fn: () => Promise<AuthState | null>): Promise<AuthState | null> {
      if (this.inflight) return this.inflight;
      this.inflight = fn().finally(() => { this.inflight = null; });
      return this.inflight;
    }
  }
  const refreshLock = new RefreshLock();

  async function refreshAndPersist(oauthAuth: AuthState & { type: "oauth" }): Promise<AuthState | null> {
    return refreshLock.run(async () => {
      const r = await refreshAccessToken(oauthAuth.refresh, server.url);
      if (r?.accessToken) {
        const cred: OAuthCredentials = {
          access: r.accessToken,
          refresh: r.refreshToken || oauthAuth.refresh,
          expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
        };
        await persistSnapshot(cred);
        return credToAuthState(cred)!;
      }
      logger.warn("token refresh failed — token may be expired, re-run /login codebuddy");
      return null;
    });
  }

  // --- auth-fetch 拦截器 + streamSimple wrapper ---
  const authFetch = createAuthFetch({
    getAuth: async () => {
      const mode = pickAuthMode(cfg, credToAuthState(syncSnapshot.value));
      if (mode === "api") return effectiveAuth(credToAuthState(syncSnapshot.value), cfg);
      return null; // oauth 多账号由账号池调度（auth-fetch 先 pool.next）
    },
    getPool: () => pool,
    server,
    buildAuthHeaders,
    resolveIdentity: resolveIdentity as any,
    decodeJwtPayload,
    refreshAndPersist,
    cfg,
    logger,
    chatCompletionsPath: CHAT_COMPLETIONS_PATH,
    maxAccountRetries: cfg.maxAccountRetries,
  });
  const streamSimple = createCodebuddyStreamSimple(authFetch, {
    buildHeaders: (model, options) =>
      buildRequestHeaders(options?.sessionId, model.id, { cfg, server, lru: conversationIds }),
  });

  // --- 模型列表 ---
  function modelsFromRemote(remote: RemoteModel[]) {
    return remote.map(remoteModelToPi);
  }
  const bootModels = await loadModelsSnapshot();
  function fallbackModels() {
    // 兜底顺序：上次成功发现的快照 > 单 auto。保证启动注册与 refreshModels 绝不从空列表/未知状态开始。
    return bootModels.length > 0 ? bootModels : modelsFromRemote([DEFAULT_MODEL]);
  }
  let registeredModels = fallbackModels();

  // 主动发现 + 重注册（registerProvider 可随时调用并立即生效）；多账号时 429/401 顺延切换
  async function discoverWithFailover(): Promise<void> {
    const tried = new Set<string>();
    for (let i = 0; i < Math.max(pool.size(), 1); i++) {
      const pick = pool.next(tried);
      if (!pick) {
        logger.warn("no available account for model discovery");
        return;
      }
      tried.add(pick.id);
      try {
        const remote = await discoveryCache.get(pick.auth.access, { signal: undefined });
        const models = modelsFromRemote(remote);
        if (!models.length) { logger.warn(`model discovery empty via ${pick.id}, try next account`); continue; }
        registeredModels = models;
        void saveModelsSnapshot(models);
        try {
          register(models);
        } catch (regErr) {
          logger.error(`registerProvider failed: ${(regErr as Error).message}`);
          return;
        }
        logger.info(`model discovery ok via ${pick.id}: ${models.length} models registered`);
        return;
      } catch (e) {
        const status = (e as any)?.status;
        if (status === 429) { logger.warn(`model discovery 429 on ${pick.id}, cooldown`); await pool.markCooldown(pick.id); continue; }
        if (status === 401 || status === 403) { logger.warn(`model discovery 401/403 on ${pick.id}, invalid`); await pool.markInvalid(pick.id, "discovery auth rejected"); continue; }
        // 非 401/403 的失败（5xx/超时/网络）也换下一账号重试，全部失败才保留现状
        logger.warn(`model discovery failed via ${pick.id}: ${(e as Error).message}${(e as any)?.status ? ` (status=${(e as any).status})` : ""}`);
        continue;
      }
    }
    logger.warn("all accounts failed model discovery, keeping previous model list");
  }

  // 发现防抖：并发调用合并为一次 inflight，避免重复发起
  let discoveryInflight: Promise<void> | null = null;
  function runDiscovery(): Promise<void> {
    if (discoveryInflight) return discoveryInflight;
    discoveryInflight = discoverWithFailover().finally(() => { discoveryInflight = null; });
    return discoveryInflight;
  }

  function register(models: typeof registeredModels) {
    pi.registerProvider(PROVIDER_ID, {
      name: "CodeBuddy",
      baseUrl: `${server.url}/v2`,
      api: "codebuddy-oauth",
      // 认证统一由 auth-fetch 拦截器注入（oauth 双头身份 + api 双头 key）；
      // apiKey 仅作为 OpenAI client 的占位（拦截器会覆写 Authorization）
      apiKey: cfg.apiKey || "not-used",
      models: models.map((m) => ({ ...m, compat: CODEBUDDY_COMPAT })) as any,
      streamSimple,
      oauth: {
        name: "CodeBuddy (IOA)",
        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const state = await requestAuthState(server.url);
          callbacks.onAuth({ url: state.url, instructions: "请在浏览器中完成 IOA 登录" });
          const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS;
          const tok = await pollForToken(server.url, state.state, expiresAt, callbacks.signal);
          if (!tok?.accessToken) throw new Error("CodeBuddy IOA login failed or timed out");
          const cred: OAuthCredentials = {
            access: tok.accessToken,
            refresh: tok.refreshToken || "",
            expires: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
          await persistSnapshot(cred);
          // 按 JWT 身份去重：同账号重登覆盖，不同账号自动追加（多账号不再强制用 /codebuddy-accounts add）
          const loginUserId = resolveIdentity(decodeJwtPayload(cred.access) as any, cfg).userId;
          const placed = await pool.upsertByLogin(cred, loginUserId);
          if (placed.created) logger.info(`codebuddy: logged in as new account ${placed.id} (userId=${loginUserId ?? "unknown"})`);
          else logger.info(`codebuddy: login refreshed account ${placed.id}`);
          // 登录后立即发现模型并重注册（Pi 的 credential-change refresh 走 allowNetwork:false，不触发网络发现）
          void runDiscovery();
          return cred;
        },
        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          if (!credentials.refresh) throw new Error("codebuddy: no refresh token stored");
          const r = await refreshAccessToken(credentials.refresh, server.url);
          if (!r?.accessToken) throw new Error("codebuddy: token refresh failed — re-run /login codebuddy");
          const cred: OAuthCredentials = {
            access: r.accessToken,
            refresh: r.refreshToken || credentials.refresh,
            expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
          await persistSnapshot(cred);
          const hit = pool.findByRefresh(credentials.refresh);
          if (hit) await pool.updateCred(hit.id, cred);
          else logger.warn("codebuddy: refresh succeeded but no matching account in pool");
          return cred;
        },
        getApiKey(credentials: OAuthCredentials): string {
          return credentials.access;
        },
      },
      refreshModels: async (context: { credential?: { type?: string; access?: string }; allowNetwork?: boolean; signal?: AbortSignal }) => {
        logger.info(`refreshModels called: allowNetwork=${String(context.allowNetwork)} credType=${context.credential?.type} poolSize=${pool.size()} registered=${registeredModels.length}`);
        // 1) Pi 允许网络 → 优先用凭据 access 发现（保持原有语义）
        const cred = context.credential?.type === "oauth" ? context.credential : undefined;
        if (cred?.access && context.allowNetwork) {
          try {
            const remote = await discoveryCache.get(cred.access, { signal: context.signal });
            const models = modelsFromRemote(remote);
            if (models.length) {
              logger.info(`refreshModels -> credential discovery: ${models.length} models`);
              return models as any;
            }
          } catch (e) {
            logger.warn(`model discovery failed via credential: ${(e as Error).message}`);
          }
        }
        // 2) 凭据发现不可用/失败 → 用账号池补一次发现，避免把 fallback [auto] 当作模型列表返回，
        //    否则 omp 在启动解析 config 模型引用时（如 default: codebuddy/hy4-preview）会拿到 auto-only 列表并覆盖
        if (pool.size() > 0) {
          await runDiscovery();
        }
        logger.info(`refreshModels -> returning registeredModels: ${registeredModels.length} models`);
        return registeredModels as any;
      },
    } as any);
  }

  register(registeredModels);

  // --- 多账号管理命令：/codebuddy-accounts（list / add / remove <id>）---
  // omp 命令 handler 返回 void：文本输出走 ui.notify（无 UI 时降级 logger）
  const commandOut = (ctx: any, text: string): void => {
    if (ctx.ui?.notify) ctx.ui.notify(text, "info");
    else logger.info(text);
  };
  async function runAddAccount(ctx: any): Promise<void> {
    let state;
    try {
      state = await requestAuthState(server.url);
    } catch (e) {
      commandOut(ctx, `发起登录失败: ${(e as Error).message}`);
      return;
    }
    try { execFile("open", [state.url]); } catch { /* 无法唤起浏览器则靠 notify 链接 */ }
    ctx.ui?.notify?.(`[codebuddy] 请在浏览器完成登录：${state.url}`, "info");
    const tok = await pollForToken(server.url, state.state, Date.now() + 5 * 60 * 1000, undefined);
    if (!tok?.accessToken) { commandOut(ctx, "登录超时或失败（5 分钟内未完成）"); return; }
    const cred = {
      access: tok.accessToken,
      refresh: tok.refreshToken || "",
      expires: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
    };
    let name: string | undefined;
    if (ctx.ui?.input) { try { name = await ctx.ui.input("账号名称（可留空）", { defaultValue: "" }); } catch {} }
    const rec = await pool.append(cred, name || undefined);
    ctx.ui?.notify?.(`已添加 codebuddy 账号 ${rec.name} (${rec.id})`, "success");
    void runDiscovery();
  }
  pi.registerCommand("codebuddy-accounts", {
    description: "管理 CodeBuddy 多账号（list / add / strategy / remove <id>）",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trim();
      const mStrategy = trimmed.match(/^strategy\s+(.*)$/);
      if (mStrategy) {
        const items = ["failover", "round-robin"].map((v) => ({ value: v, label: v === "failover" ? "故障转移（仅 429/401 切换）" : "轮转（请求间均衡）" }));
        return items.filter((i) => i.value.startsWith(mStrategy[1] || ""));
      }
      const mRemove = trimmed.match(/^remove\s+(.*)$/);
      if (mRemove) {
        const items = pool.list().map((a) => ({ value: `${a.id}`, label: `${a.id}  ${a.name}  ${a.status === "ok" ? "正常" : a.status === "cooldown" ? "冷却中" : "认证失效"}` }));
        return items.filter((i) => i.value.startsWith(mRemove[1] || ""));
      }
      const items = ["list", "add", "strategy", "remove"].map((v) => ({ value: v, label: v }));
      const filtered = items.filter((i) => i.value.startsWith(trimmed));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: any) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);
      const cmd = argv[0] ?? "list";
      if (cmd === "add") { await runAddAccount(ctx); return; }
      if (cmd === "strategy") {
        const val = argv[1];
        if (!val) {
          commandOut(ctx, `当前调度策略：${pool.getStrategy()}。failover=仅 429/401 时切换；round-robin=请求间轮转。切换：/codebuddy-accounts strategy <failover|round-robin>`);
          return;
        }
        const v = val.toLowerCase();
        if (v !== "failover" && v !== "round-robin") {
          commandOut(ctx, "用法：/codebuddy-accounts strategy [failover|round-robin]");
          return;
        }
        await pool.setStrategy(v as "round-robin" | "failover");
        commandOut(ctx, `调度策略已切换为 ${v}（已持久化，无需重启）`);
        return;
      }
      if (cmd === "remove") {
        const id = argv[1];
        if (!id) { commandOut(ctx, "usage: /codebuddy-accounts remove <id>"); return; }
        const acc = pool.list().find((a) => a.id === id);
        if (!acc) { commandOut(ctx, `no account: ${id}`); return; }
        let ok = true;
        if (ctx.ui?.confirm) { try { ok = await ctx.ui.confirm(`删除账号 ${acc.name} (${id})？`, { default: false }); } catch { ok = true; } }
        if (!ok) { commandOut(ctx, "已取消"); return; }
        await pool.remove(id);
        commandOut(ctx, `已删除账号 ${acc.name} (${id})`);
        return;
      }
      const rows = pool.list();
      if (!rows.length) { commandOut(ctx, "暂无 codebuddy 账号 — 运行 /codebuddy-accounts add 添加，或 /login codebuddy 登录主账号"); return; }
      const avail = rows.filter((r) => r.status === "ok").length;
      const lines = rows.map((r) => {
        if (r.status === "invalid") return `✗ ${r.id.padEnd(10)} ${r.name}  认证失效: ${r.invalidReason ?? "unknown"} — 重登: /codebuddy-accounts add`;
        if (r.status === "cooldown") return `○ ${r.id.padEnd(10)} ${r.name}  冷却中 ${Math.ceil(r.cooldownRemainingMs / 1000)}s`;
        return `● ${r.id.padEnd(10)} ${r.name}  正常`;
      });
      commandOut(ctx, `codebuddy 账号 (${avail}/${rows.length} 可用)\n` + lines.join("\n"));
    },
  });

  // 启动时已有账号 → 后台发现真实模型列表（不阻塞启动）
  const mode = pickAuthMode(cfg, credToAuthState(syncSnapshot.value));
  if (mode === "oauth" && pool.size() > 0) {
    void runDiscovery();
  } else if (mode === "api" && !cfg.apiKey) {
    logger.warn("api key mode requested but no key found — set CODEBUDDY_API_KEY");
  }

  // --- compaction 后淘汰 conversation-id（对应 opencode session.compacted）---
  pi.on("session_before_compact", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid) conversationIds.delete(sid);
  });
}
