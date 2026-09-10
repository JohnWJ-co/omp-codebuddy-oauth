// src/stream.ts — streamSimple wrapper：包 omp 内置 @oh-my-pi/pi-ai openai-completions 实现，注入自定义 fetch。
// 协议栈（消息转换 / tool-calling / SSE 解析）全部复用 pi-ai；本模块负责：
// 1. options.headers 注入 CodeBuddy 22 头（X-Conversation-ID 稳定化等，provider 边界清晰）
// 2. options.fetch 换成 auth-fetch 拦截器（认证头注入 + 401/403 刷新重试 + 11133 退避重发）
// 3. 透传 Pi 的 onPayload / onResponse / sessionId / transformHeaders 等约定参数
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai";
import { CODEBUDDY_COMPAT } from "./models.js";

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CodebuddyStreamOptions {
  /** 构建动态请求头（X-Conversation-ID / B3 / X-Model-ID 等 22 头） */
  buildHeaders?: (model: Model<any>, options?: SimpleStreamOptions) => Record<string, string>;
}

/**
 * 包装 pi-ai 内置 openai-completions.streamSimple：
 * - headers 合并动态头（调用方 headers 优先级更高，见 prepareRequest 合并顺序）
 * - fetch 换成拦截器
 */
export function createCodebuddyStreamSimple(fetchFn: FetchFn, extra?: CodebuddyStreamOptions) {
  const builtin = streamOpenAICompletions;
  return function streamCodebuddy(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const dynamicHeaders = extra?.buildHeaders?.(model, options);
    const opts: SimpleStreamOptions = {
      ...(options ?? {}),
      ...(dynamicHeaders ? { headers: { ...options?.headers, ...dynamicHeaders } as Record<string, string> } : {}),
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    };
    // 自定义 api 不会获得 omp 内置的 model.compat 解析，兜底补上默认方言配置，
    // 否则 openai-completions 运行时访问 compat.disableReasoningOnForcedToolChoice 会崩。
    const withCompat = (model as any).compat ? model : { ...(model as any), compat: CODEBUDDY_COMPAT };
    return builtin(withCompat, context, opts as any);
  };
}
