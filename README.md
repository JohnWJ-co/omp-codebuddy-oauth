# omp-codebuddy-oauth

[![npm version](https://img.shields.io/npm/v/omp-codebuddy-oauth.svg)](https://www.npmjs.com/package/omp-codebuddy-oauth)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

为 [CodeBuddy](https://www.codebuddy.cn)（腾讯 IOA 编程助手）提供的 **omp 标准插件**（`omp.extensions` manifest），把 CodeBuddy 作为 **OpenAI 兼容 HTTP provider** 接入 [omp](https://omp.sh) / [Pi](https://github.com/earendil-works/pi)。

与 [pi-codebuddy-sdk](https://github.com/RealAlexandreAI/pi-codebuddy-sdk)（spawn `codebuddy` CLI 子进程 + MCP bridge）不同，本扩展走**轻量 HTTP 直连**（`/v2/chat/completions`）：协议栈复用 omp 内置 `openai-completions` 运行时（`@oh-my-pi/pi-ai`），扩展只负责鉴权、**多账号调度**、模型发现、动态头注入与瞬时故障重试。无 CLI 依赖、无子进程、无会话文件管理。

## 特性

- **OAuth 登录** — `/login codebuddy` 接入 IOA：`/v2/plugin/auth/state` → 浏览器 → 轮询 token。token 刷新由 omp 双检锁托管（5 分钟 skew 预刷新）。
- **多账号（负载均衡 / 故障转移）** — 多个 OAuth 账号可同时维护：遇 **429（限流）** 自动短冷却并顺延下一账号；遇 **401/403（含刷新失败）** 标记认证失效并顺延，同时提示重新登录。支持 `failover`（默认）与 `round-robin` 两种策略。
- **登录自动去重** — 按 JWT userId 识别账号：**同账号重登覆盖原 token，不同账号自动追加**，不会产生重复或"占位"账号。
- **API Key 登录** — 设置 `CODEBUDDY_API_KEY`（`ck_xxx`）即可，无需浏览器。
- **自动模型发现** — 调用 `GET /v3/config` 提取 craft agent 模型列表（5 分钟 TTL 缓存 + 单飞；登录后自动触发，多账号时顺延）。
- **模型思考等级** — 完整映射 `supportedEfforts`/`effort` 字段，所有 craft 模型均带思考等级与默认档位。
- **401/403 中途刷新重试** — 流式请求中 token 失效时自动刷新并重试一次（15 秒冷却防抖）。
- **瞬时 400（code 11133）自动重试** — CodeBuddy 网关偶发把上游瞬时校验失败包装成 HTTP 400 `{"code":11133}` 返回；拦截器按 **1s → 4s → 10s → 25s** 退避幂等重发（最多 4 次，总等待 ≤40s），其他 400 原样透传。
- **session 级 `X-Conversation-ID` 稳定化** — 同一 session 复用同一 conversation id，提升上游 prompt cache 命中率（compaction 时淘汰）。
- **环境自动切换** — 默认国内端点（`copilot.tencent.com`），`CODEBUDDY_NETWORK=internet` 切国际（`www.codebuddy.ai`），`CODEBUDDY_ENDPOINT` 覆盖完整 URL。

## 安装

```bash
omp install github:JohnWJ-co/omp-codebuddy-oauth
```

或本地路径开发调试（**symlink**，改代码后重启即生效）：

```bash
omp plugin link /path/to/omp-codebuddy-oauth
```

重启 `omp`，然后 `/model` → 选 `codebuddy/...` 模型。

## 命令

### `/login codebuddy` —— OAuth 登录（推荐）

登录 CodeBuddy 账号（腾讯 IOA），token 自动持久化到账号池。

**交互流程**：

1. 输入 `/login codebuddy`
2. 弹出浏览器并在 TUI 显示登录链接（若浏览器未自动打开，手动复制链接访问）
3. 在浏览器完成 IOA 扫码/登录授权
4. 插件轮询到 token，显示登录成功，账号写入账号池

**账号归属规则（按 JWT userId 自动去重）**：

| 场景 | 结果 |
| ---- | ---- |
| 首次登录（账号池为空） | 新增账号 `账号 1`（id=`acct-1`） |
| 再次登录**同一个**账号 | 覆盖原账号 token（不产生新条目） |
| 登录**另一个**账号 | 自动追加为新账号 `账号 2` / `账号 3` … |
| 登录时无法解析身份（userId 缺失） | 更新第一个无身份标记的旧账号，避免累加不明账号 |

连续登录多个账号即形成账号池，无需任何额外命令。

### `/codebuddy-accounts` —— 账号池管理

插件的多账号管理命令，支持三个子命令。

#### `/codebuddy-accounts`（无参数）—— 查看账号列表与状态

列出所有账号及其健康状态，输出在 TUI 通知栏：

```
codebuddy 账号 (3/3 可用)
● acct-1  账号 1  正常
○ acct-2  账号 2  冷却中 42s
✗ acct-3  账号 3  认证失效: refresh failed — 重登: /codebuddy-accounts add
```

| 状态标记 | 含义 | 恢复方式 |
| ---- | ---- | ---- |
| `● 正常` | 可参与调度 | — |
| `○ 冷却中 Ns` | 刚触发 429/401，短时间跳过 | 冷却倒计时结束自动恢复 |
| `✗ 认证失效` | token 刷新失败等，无法使用 | 重新登录（见下） |

#### `/codebuddy-accounts add` —— 显式添加新账号

与 `/login codebuddy` 等效的引导式登录，适合一次性添加多个账号时使用：

1. 插件尝试唤起系统浏览器（macOS `open`），并在 TUI 显示登录链接
2. 可选输入账号名称（回车跳过则以 `账号 N` 命名）
3. 浏览器完成登录后自动轮询并追加账号
4. 成功提示：`已添加 codebuddy 账号 账号N (acct-N)`
5. 登录超时（5 分钟未完成）会提示失败，重试即可

#### `/codebuddy-accounts remove <id>` —— 删除账号

按列表中的 id 删除（如 `/codebuddy-accounts remove acct-2`）：

1. 显示待删账号并请求确认
2. 确认后从账号池删除并持久化
3. 提示：`已删除账号 账号名 (acct-2)`

> 注意：`/login codebuddy` 触发的是 Pi/omp 原生登录流程，同样自动去重；`/codebuddy-accounts add` 是插件自建的引导登录。两者效果一致，任意选择。

### 账号失效提示

当某账号在请求中被判定认证失效（401/403 且刷新失败），会自动弹出通知：

```
codebuddy 账号「账号名」（id=acct-3）认证失效：refresh failed。
请运行 /codebuddy-accounts add 重新登录（主账号用 /login codebuddy）
```

失效账号会被调度跳过（不参与选号），`/codebuddy-accounts` 列表标为 `✗ 认证失效`，重新登录后自动恢复正常。同一账号在一个会话内只提示一次，避免刷屏。

### 多账号调度行为

- **failover（默认，`CODEBUDDY_STRATEGY=failover`）**：优先使用顺序靠前的可用账号；当前账号 **429** → 短冷却并顺延；**401/403** 刷新失败 → 标记失效并顺延。
- **round-robin（`CODEBUDDY_STRATEGY=round-robin`）**：每次请求从下一账号开始（请求间轮转），遇故障同样顺延。
- 冷却窗口默认 60s（`CODEBUDDY_ACCOUNT_COOLDOWN_MS` 可调）；单请求最多顺延 `CODEBUDDY_MAX_ACCOUNT_RETRIES` 个账号（默认 0 = 账号数 - 1 自动）。
- 全部账号不可用时，回退到第一个未尝试账号再试一次，避免彻底不可用。

## 环境变量

| 变量 | 默认 | 作用 |
| ---- | ---- | ---- |
| `CODEBUDDY_ENDPOINT` | _(空)_ | 完整 base URL 覆盖，优先级最高 |
| `CODEBUDDY_NETWORK` | `internal` | `internal`/`ioa` → 国内端点；其他 → 国际端点 |
| `CODEBUDDY_AUTH` | `auto` | `auto` / `oauth` / `api` |
| `CODEBUDDY_API_KEY` | _(空)_ | API Key（`ck_xxx`），`auto` 模式下隐含启用 API Key 模式 |
| `CODEBUDDY_STRATEGY` | `failover` | 多账号调度：`failover`（429/401 才切换）/ `round-robin`（请求间轮转） |
| `CODEBUDDY_ACCOUNT_COOLDOWN_MS` | `60000` | 429/401 后账号短冷却窗口（毫秒） |
| `CODEBUDDY_MAX_ACCOUNT_RETRIES` | `0` | 单请求最多额外尝试的账号数；`0` = 账号数-1 自动 |
| `CODEBUDDY_ACCOUNTS_FILE` | `~/.omp/agent/codebuddy-accounts.json` | 多账号池文件路径（写权限 0600） |
| `CODEBUDDY_MODEL` | _(空)_ | 强制覆盖请求 model（写进 `X-Model-ID`） |
| `CODEBUDDY_STABLE_CONVERSATION` | `1` | `0` 关闭 session 级 conversation-id 稳定化 |
| `CODEBUDDY_CONVERSATION_MAP_MAX` | `1000` | session → conversationId LRU 容量 |
| `CODEBUDDY_TENANT_ID` / `CODEBUDDY_ENTERPRISE_ID` / `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖自动提取的身份头（仅 OAuth 模式） |

## 架构

```
omp agent
  │ modelRuntime.streamSimple（auth 解析 / 凭据刷新）
  ▼
streamSimple wrapper（src/stream.ts）
  │ 注入 22 头（X-Conversation-ID 稳定化 / B3 / X-Model-ID …）
  │ 注入自定义 fetch
  ▼
auth-fetch 拦截器（src/auth-fetch.ts）
  │ 认证头注入（oauth: Bearer + 租户身份头 / api: Bearer + X-API-Key）
  │ 多账号调度（round-robin/failover + 冷却/失效）
  │ 401/403 → 刷新 token 重试一次，失败标记失效并顺延
  │ 429 → 短冷却并顺延下一账号
  │ 400+11133 → 1s/4s/10s/25s 幂等重发
  ▼
${server}/v2/chat/completions   （协议栈：omp 内置 openai-completions）
```

token 的过期预检与刷新由 omp 原生托管（`oauth.refreshToken`，5 分钟 skew + 双检锁，自动持久化到凭据存储）；扩展维护账号池文件（`~/.omp/agent/codebuddy-accounts.json`）供请求期读取与多账号调度，所有账号统一命名（`账号 1` / `账号 2` …），按 JWT userId 去重。

| 模块 | 来源 |
| ---- | ---- |
| `auth-flow.ts` / `auth-state.ts` / `jwt.ts` / `headers.ts` / `lru.ts` / `fetch-json.ts` | 平移自 [opencode-codebuddy-oauth](https://github.com/minglo/opencode-codebuddy-oauth) |
| `models.ts` | 平移 + 转换为 omp `ProviderModelConfig`（含思考等级与 compat 补齐） |
| `accounts.ts` | 多账号池（按 userId 去重、统一命名、选号/冷却/失效） |
| `auth-fetch.ts` | 平移改造：删 SSE 缓冲与预刷新，增加多账号重试循环 |
| `index.ts` / `stream.ts` | omp extension 接线 |

## 开发

```bash
npm install
npm test        # vitest
npm run typecheck
```

## 许可证

[MIT](./LICENSE) — © 2026 SoulChildTc；部分代码源自 [opencode-codebuddy-oauth](https://github.com/minglo/opencode-codebuddy-oauth) © 2026 Ming Lo (MIT)
