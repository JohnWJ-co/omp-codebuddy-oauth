// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/models.ts — 平移自 opencode-codebuddy-oauth；RemoteModel → Pi ProviderModelConfig
import { fetchJson } from "./fetch-json.js";
import { AGENT_INTENT, DISCOVERY_TIMEOUT_MS, IDE_NAME, IDE_TYPE, IDE_VERSION, APP_VERSION, ENV_ID, PRODUCT } from "./config.js";

export interface RemoteModel { id:string; name:string; maxInputTokens?:number; maxOutputTokens?:number; maxAllowedSize?:number; supportsToolCall?:boolean; supportsImages?:boolean; supportsReasoning?:boolean; disabledMultimodal?:boolean; reasoning?:{ effort?:string; defaultEffort?:string; supportedEfforts?:string[] }; }
export const DEFAULT_MODEL: RemoteModel = { id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true };

export interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string>;
}

export interface RemoteConfigResponse { code:number; data?:{ agents?:Array<{name:string; models?:string[]}>; models?:RemoteModel[] } }
export async function fetchRemoteModels(
  accessToken: string,
  server: { url: string; domain: string },
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
  const headers: Record<string,string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": AGENT_INTENT,
    "X-IDE-Type": IDE_TYPE, "X-IDE-Name": IDE_NAME, "X-IDE-Version": IDE_VERSION,
    "X-Product-Version": APP_VERSION, "X-Env-ID": ENV_ID,
    "X-Domain": server.domain, "X-Product": PRODUCT,
    "User-Agent": `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
  };
  const res = await fetchJson<RemoteConfigResponse>(`${server.url}/v3/config`, {
    headers, timeoutMs: DISCOVERY_TIMEOUT_MS, signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`discovery ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    return [];
  }
  const body = res.data;
  if (!body || body.code !== 0 || !body.data) return [];
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === AGENT_INTENT);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return [];
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false);
}

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_TOKENS = 8192;

function detectThinking(id: string): boolean {
  return /claude|gemini|gpt|hy\d|deepseek|glm|kimi|minimax|hunyuan/i.test(id);
}

function detectImages(id: string): boolean {
  return /claude|gemini|gpt|5v|vision|image/i.test(id);
}

/** RemoteModel → Pi ProviderModelConfig 所需字段 */
export function remoteModelToPi(m: RemoteModel): PiModelConfig {
  const contextWindow = m.maxAllowedSize ?? m.maxInputTokens ?? DEFAULT_CONTEXT;
  const maxTokens = m.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const serverReasoning = m.reasoning !== undefined;
  const cfg: PiModelConfig = {
    id: m.id,
    name: m.name,
    // 以服务端 reasoning 声明为准（名字正则仅作兜底），否则 hy4/kimi/minimax 等被漏判
    reasoning: m.supportsReasoning !== false && (serverReasoning || detectThinking(m.id)),
    input: (detectImages(m.id) && !m.disabledMultimodal) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
  const efforts = m.reasoning?.supportedEfforts;
  if (cfg.reasoning && (efforts?.length || effort)) {
    // 完整格式：supportedEfforts；简化格式（仅 effort 字段）：以该档案为唯一点位
    const levels = efforts?.length ? efforts : [effort as string];
    cfg.thinkingLevelMap = Object.fromEntries(levels.map((e) => [e, e]));
    if (effort) cfg.thinkingLevelMap.default = effort;
  }
  return cfg;
}

/**
 * omp 的 openai-completions 运行时要求 model.compat 提供方言配置；
 * 自定义 api（codebuddy-oauth）不会走 omp 内置的 compat 解析，这里按
 * 标准 OpenAI 兼容网关默认值补齐（CodeBuddy /v2/chat/completions 对齐）。
 */
export const CODEBUDDY_COMPAT = {
  supportsUsageInStreaming: true,
  supportsStore: false,
  maxTokensField: "max_tokens",
  zaiToolStream: false,
  supportsDeveloperRole: false,
  supportsMultipleSystemMessages: true,
  supportsReasoningEffort: true,
  supportsReasoningParams: true,
  reasoningDisableMode: "none-effort",
  thinkingFormat: "openai",
  disableReasoningOnForcedToolChoice: false,
  disableReasoningOnToolChoice: false,
  supportsForcedToolChoice: true,
  omitReasoningEffort: false,
  includeEncryptedReasoning: false,
  filterReasoningHistory: false,
  requiresReasoningContentForToolCalls: false,
  requiresReasoningContentForAllAssistantTurns: false,
  allowsSyntheticReasoningContentForToolCalls: false,
  requiresThinkingAsText: false,
  strictResponsesPairing: false,
  requiresMistralToolIds: false,
  usesOpenAIToolCallIdLimit: false,
  stripDeepseekSpecialTokens: false,
  reasoningDeltasMayBeCumulative: false,
  emptyLengthFinishIsContextError: false,
  isOpenRouterHost: false,
  isVercelGatewayHost: false,
  supportsPenaltyAndStopParams: true,
};

export class DiscoveryCache {
  private data: RemoteModel[] | null = null;
  private fetchedAt = 0;
  private inflight: Promise<RemoteModel[]> | null = null;
  private readonly fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteModel[]>;
  constructor(private opts: { ttlMs:number; fetchFn: (token: string, signal?: AbortSignal)=>Promise<RemoteModel[]> }) { this.fetchFn = opts.fetchFn; }
  async get(token:string, { signal }: { signal?:AbortSignal }): Promise<RemoteModel[]> {
    const now = Date.now();
    if (this.data && (now - this.fetchedAt) < this.opts.ttlMs) return this.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchFn(token, signal).then(d => { this.data = d; this.fetchedAt = Date.now(); return d; }).catch(e => {
      if ((e as any)?.status === 401 || (e as any)?.status === 403) throw e;
      // 失败不降级：有旧数据则沿用旧列表；无旧数据则抛出，由调用方换账号或保留现状
      if (this.data) return this.data;
      throw e;
    }).finally(() => { this.inflight = null; });
    if (this.data) { this.inflight.catch(() => {}); return this.data; }
    return this.inflight;
  }
}
