# DSH 服务接入协议（草案）

> 状态：草案 v0.1 ｜ 日期：2026-11-04
>
> 本文档描述插件**期望** dsh 服务提供的接口，用途有两个：一是和 dsh 服务方对齐接口，二是作为 `mock-dsh` 的实现依据。
> 如果 dsh 已经有现成接口，以真实接口为准，在插件的 Adapter 层做映射，本文档改为记录映射关系。
>
> 相关文档：[整体方案](./DESIGN.md)

---

## 目录

1. [适用范围](#1-适用范围)
2. [传输方式](#2-传输方式)
3. [认证](#3-认证)
4. [消息总览](#4-消息总览)
5. [方法详解](#5-方法详解)
6. [工具定义](#6-工具定义)
7. [错误码](#7-错误码)
8. [内部事件模型（Adapter 输出）](#8-内部事件模型adapter-输出)
9. [dsh 只提供模型推理时](#9-dsh-只提供模型推理时)
10. [断线重连与幂等](#10-断线重连与幂等)
11. [版本与兼容](#11-版本与兼容)
12. [Mock 服务](#12-mock-服务)
13. [需要 dsh 服务方提供的信息](#13-需要-dsh-服务方提供的信息)

---

## 1. 适用范围

第 2～8 节对应 [DESIGN.md D2](./DESIGN.md#d2-agentbackend-抽象兼容两种-dsh-形态) 中的 `RemoteAgentBackend`，即 **dsh 是 Agent 服务**：服务端负责 Agent 循环，需要读写代码或执行命令时，向插件发起工具调用，插件在本地执行后回传结果。

如果 dsh 只提供模型推理（如 OpenAI 兼容接口），见[第 9 节](#9-dsh-只提供模型推理时)。

---

## 2. 传输方式

### 2.1 首选：WebSocket + JSON-RPC 2.0

- 地址：`wss://<dsh-host>/v1/agent/ws`（具体路径待定）
- 帧类型：文本帧，UTF-8，每帧一条 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 消息
- 选择理由：一轮对话中，dsh 需要**主动**向插件发请求（工具调用），双向通道最直接
- 心跳：客户端每 30 秒发一次 WebSocket ping，连续 2 次没有 pong 视为断线

### 2.2 备选：HTTP + SSE

如果 dsh 不方便提供 WebSocket：

| 用途 | 接口 |
| --- | --- |
| 开始一轮，返回事件流 | `POST /v1/turns` → `text/event-stream` |
| 回传工具结果 | `POST /v1/turns/{turnId}/tool-results` |
| 中断 | `POST /v1/turns/{turnId}/interrupt` |
| 模型列表 | `GET /v1/models` |

SSE 事件的 `event` 字段对应第 4 节的方法名，`data` 字段对应 `params`。工具调用以 `tool/call` 事件下发，插件通过 `tool-results` 接口回传。

---

## 3. 认证

- 建立连接时带请求头 `Authorization: Bearer <token>`（插件运行在 Node 环境，可以设置 WebSocket 握手请求头）
- Token 由用户通过「DSH：登录」命令输入，保存在 VS Code `SecretStorage`
- Token 失效时，服务端返回错误码 `-32001`（见第 7 节）并关闭连接；插件提示用户重新登录，不自动重试
- 后续如接入 OAuth / 企业 SSO，只替换 Token 的获取方式，协议不变

---

## 4. 消息总览

| 方向 | 方法 | 类型 | 说明 |
| --- | --- | --- | --- |
| 插件 → dsh | `initialize` | 请求 | 握手：协议版本、客户端信息、工具定义 |
| 插件 → dsh | `models/list` | 请求 | 获取可用模型 |
| 插件 → dsh | `thread/start` | 请求 | 创建会话 |
| 插件 → dsh | `thread/resume` | 请求 | 恢复已有会话（dsh 支持会话持久化时） |
| 插件 → dsh | `turn/start` | 请求 | 开始一轮对话，立即返回 `turnId`，后续内容通过通知推送 |
| 插件 → dsh | `turn/interrupt` | 请求 | 中断进行中的轮次 |
| dsh → 插件 | `turn/started` | 通知 | 轮次开始 |
| dsh → 插件 | `item/started` | 通知 | 新条目开始（回复文本、推理摘要） |
| dsh → 插件 | `item/delta` | 通知 | 条目增量（流式文本） |
| dsh → 插件 | `item/completed` | 通知 | 条目结束，带完整内容 |
| dsh → 插件 | `turn/completed` | 通知 | 轮次结束：完成 / 中断 / 失败，带 Token 用量 |
| dsh → 插件 | `tool/call` | **请求** | 让插件执行工具，插件在响应中返回结果 |

说明：

- 工具调用条目由插件在收到 `tool/call` 时自行生成，dsh 不需要再为工具调用发 `item/*` 通知
- 所有通知都带 `turnId` 和单调递增的 `seq`（每轮内从 1 开始），用于排序、去重和断线恢复

---

## 5. 方法详解

### 5.1 `initialize`

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "0.1",
    "client": {
      "name": "dsh-vscode",
      "version": "0.1.0",
      "vscodeVersion": "1.95.0",
      "platform": "darwin",
      "locale": "zh-cn"
    },
    "tools": [
      {
        "name": "read_file",
        "description": "读取工作区内的文件内容，返回带行号的文本",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string" },
            "startLine": { "type": "integer" },
            "endLine": { "type": "integer" }
          },
          "required": ["path"]
        }
      }
    ]
  }
}
```

响应：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "0.1",
    "server": { "name": "dsh", "version": "1.0.0" },
    "capabilities": {
      "reasoningSummary": true,
      "threadPersistence": false,
      "turnResume": false
    }
  }
}
```

`tools` 是插件支持的全部工具定义（完整定义见[第 6 节](#6-工具定义)）。每一轮实际可用的工具由 `turn/start` 的 `enabledTools` 决定（例如问答模式下不开放写文件和执行命令）。

### 5.2 `models/list`

```json
{ "jsonrpc": "2.0", "id": 2, "method": "models/list", "params": {} }
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "models": [
      {
        "id": "dsh-pro",
        "displayName": "DSH Pro",
        "contextWindow": 200000,
        "supportsReasoning": true,
        "reasoningEfforts": ["low", "medium", "high"],
        "default": true
      }
    ]
  }
}
```

### 5.3 `thread/start` / `thread/resume`

```json
{ "jsonrpc": "2.0", "id": 3, "method": "thread/start", "params": { "model": "dsh-pro" } }
```

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "threadId": "th_123" } }
```

`thread/resume` 参数为 `{ "threadId": "th_123" }`。如果 dsh 不做会话持久化（`threadPersistence: false`），插件在每轮 `turn/start` 中带上完整历史（见 5.4 的 `history` 字段）。

### 5.4 `turn/start`

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "turn/start",
  "params": {
    "threadId": "th_123",
    "model": "dsh-pro",
    "input": [
      { "type": "text", "text": "帮我给 parseDate 加单元测试" },
      {
        "type": "file",
        "path": "src/utils.ts",
        "range": { "startLine": 12, "endLine": 30 },
        "content": "export function parseDate(s: string) { ... }"
      }
    ],
    "history": [],
    "environment": {
      "workspaceFolders": ["my-app"],
      "os": "darwin",
      "shell": "zsh",
      "gitBranch": "main"
    },
    "enabledTools": ["read_file", "list_dir", "glob", "grep", "apply_patch", "run_command"],
    "options": { "reasoningEffort": "medium" }
  }
}
```

响应（立即返回）：

```json
{ "jsonrpc": "2.0", "id": 4, "result": { "turnId": "tu_456" } }
```

说明：

- `input` 中的 `type` 可以是 `text`、`file`、`folder`（目录树摘要）、`problems`（诊断列表）、`changes`（git diff）、`image`（后续支持）
- `environment` 只发相对信息，**不发绝对路径和用户名**
- 同一会话上一轮还没结束时再次调用，返回错误 `-32011`

### 5.5 流式通知

```json
{ "jsonrpc": "2.0", "method": "turn/started", "params": { "turnId": "tu_456", "seq": 1 } }
```

```json
{
  "jsonrpc": "2.0",
  "method": "item/started",
  "params": { "turnId": "tu_456", "seq": 2, "item": { "id": "it_1", "type": "agentMessage" } }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "item/delta",
  "params": { "turnId": "tu_456", "seq": 3, "itemId": "it_1", "delta": { "text": "好的，我先看一下" } }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "item/completed",
  "params": {
    "turnId": "tu_456",
    "seq": 9,
    "item": { "id": "it_1", "type": "agentMessage", "text": "好的，我先看一下现有实现。" }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "turn/completed",
  "params": {
    "turnId": "tu_456",
    "seq": 30,
    "status": "completed",
    "usage": { "inputTokens": 5210, "outputTokens": 860 }
  }
}
```

- `item.type` 目前有 `agentMessage`（Markdown 回复）和 `reasoning`（推理摘要），插件遇到不认识的类型按纯文本展示
- `turn/completed.status` 取值：`completed`、`interrupted`、`failed`；`failed` 时带 `error: { code, message }`

### 5.6 `tool/call`（dsh → 插件）

请求：

```json
{
  "jsonrpc": "2.0",
  "id": "srv-7",
  "method": "tool/call",
  "params": {
    "turnId": "tu_456",
    "callId": "call_1",
    "name": "apply_patch",
    "arguments": {
      "changes": [
        {
          "path": "src/utils.ts",
          "type": "modify",
          "edits": [{ "oldText": "return new Date(s);", "newText": "return new Date(s.trim());" }]
        },
        { "path": "src/utils.test.ts", "type": "add", "content": "import { parseDate } from './utils';\n..." }
      ]
    }
  }
}
```

响应：

```json
{
  "jsonrpc": "2.0",
  "id": "srv-7",
  "result": {
    "callId": "call_1",
    "status": "success",
    "output": "已修改 src/utils.ts（+1 -1），新建 src/utils.test.ts（+42）"
  }
}
```

`status` 取值：

| 值 | 含义 | `output` 内容 |
| --- | --- | --- |
| `success` | 执行成功 | 执行结果（超过上限会截断，并注明截断） |
| `error` | 执行失败（文件不存在、补丁匹配失败、命令非零退出等） | 错误信息，便于模型修正后重试 |
| `rejected` | 用户拒绝 | 用户填写的拒绝原因（可能为空） |
| `timeout` | 执行超时 | 超时前的部分输出 |

**注意**：`tool/call` 的响应可能要等用户审批，耗时不确定。dsh 侧不应对 `tool/call` 设置短超时（建议不设超时，或不少于 30 分钟）；用户中断时，插件会先对挂起的 `tool/call` 回 `rejected`，再发 `turn/interrupt`。

### 5.7 `turn/interrupt`

```json
{ "jsonrpc": "2.0", "id": 5, "method": "turn/interrupt", "params": { "turnId": "tu_456" } }
```

dsh 收到后应尽快停止生成，并发送 `turn/completed`（`status: "interrupted"`）。

---

## 6. 工具定义

路径约定：

- 一律使用**相对于工作区根目录**的路径，分隔符统一为 `/`
- 多根工作区（multi-root）时，路径以工作区文件夹名开头，如 `frontend/src/main.ts`
- 插件会拒绝越出工作区的路径，除非用户确认

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `read_file` | `path`，`startLine?`，`endLine?` | 带行号的文本；文件过大时返回前若干行并提示用行范围读取 |
| `list_dir` | `path`，`depth?`（默认 1，最大 3） | 目录树文本，已排除 `.gitignore` 和 `files.exclude` 中的条目 |
| `glob` | `pattern`，`maxResults?`（默认 200） | 匹配的文件路径列表 |
| `grep` | `pattern`，`isRegex?`，`include?`，`caseSensitive?`，`maxResults?`（默认 100） | `路径:行号: 内容` 列表 |
| `apply_patch` | `changes[]`：`{ path, type: "add" \| "modify" \| "delete", content?, edits?: [{ oldText, newText }] }` | 每个文件的执行结果和增删行数 |
| `write_file` | `path`，`content` | 写入结果 |
| `run_command` | `command`，`cwd?`（相对路径），`timeoutSeconds?` | 退出码 + 合并后的 stdout/stderr（截断） |
| `get_diagnostics` | `path?`（为空时返回全部） | 诊断列表：路径、行号、级别、信息 |

`apply_patch` 规则：

- `modify` 用 `edits` 做"查找替换"：`oldText` 必须在文件中**唯一**匹配；精确匹配失败时，插件再按"忽略行首尾空白"匹配一次；仍然失败则返回 `error`，并告知原因（未找到 / 匹配到多处）
- `add` 用 `content` 提供完整内容；文件已存在时返回 `error`
- `delete` 不需要其他参数
- 一次调用中所有文件作为一个整体审批；任何一个文件失败，整次调用都不落盘

> 选用"查找替换"而不是行号补丁（unified diff），是因为模型给出的行号容易错位，按文本匹配更稳定。

---

## 7. 错误码

沿用 JSON-RPC 2.0 标准错误码，另定义业务错误码：

| 错误码 | 含义 | 插件处理 |
| --- | --- | --- |
| `-32700` / `-32600` / `-32601` / `-32602` / `-32603` | JSON-RPC 标准错误 | 记录日志，提示"服务异常" |
| `-32001` | 未认证 / Token 失效 | 提示重新登录 |
| `-32002` | 无权限 | 提示联系管理员 |
| `-32003` | 请求过于频繁，`data.retryAfterSeconds` 给出等待时间 | 倒计时后允许重试 |
| `-32004` | 模型不可用 | 提示切换模型 |
| `-32005` | 上下文超长 | 提示新建会话或减少附件 |
| `-32010` | 轮次不存在 | 标记轮次失败 |
| `-32011` | 会话中已有进行中的轮次 | 提示等待或先停止 |

错误对象格式：

```json
{ "code": -32003, "message": "rate limited", "data": { "retryAfterSeconds": 20 } }
```

---

## 8. 内部事件模型（Adapter 输出）

无论 dsh 是哪种形态，`AgentBackend` 都要把 dsh 的消息转换成下面的统一结构，上层（`TurnRunner`、UI）只认这一套：

```ts
interface AgentBackend {
  /** 开始一轮对话，返回事件流；工具调用通过 ctx.executeTool 交给上层处理 */
  startTurn(input: TurnInput, ctx: TurnContext): AsyncIterable<AgentEvent>;
  listModels(): Promise<ModelInfo[]>;
}

interface TurnContext {
  signal: AbortSignal;
  /** 由 TurnRunner 提供：审批 → 执行 → 更新 UI → 返回结果 */
  executeTool(call: ToolCall): Promise<ToolResult>;
}

interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
}

interface ToolResult {
  status: 'success' | 'error' | 'rejected' | 'timeout';
  output: string;
}

type AgentEvent =
  | { type: 'turnStarted'; turnId: string }
  | { type: 'itemStarted'; itemId: string; kind: 'agentMessage' | 'reasoning' }
  | { type: 'itemDelta'; itemId: string; text: string }
  | { type: 'itemCompleted'; itemId: string; text: string }
  | {
      type: 'turnCompleted';
      status: 'completed' | 'interrupted' | 'failed';
      usage?: { inputTokens: number; outputTokens: number };
      error?: { code: string; message: string };
    };
```

协议映射（`RemoteAgentBackend`）：

| dsh 消息 | 内部处理 |
| --- | --- |
| `turn/started` | `turnStarted` |
| `item/started` / `item/delta` / `item/completed` | `itemStarted` / `itemDelta` / `itemCompleted` |
| `turn/completed` | `turnCompleted` |
| `tool/call` | 调用 `ctx.executeTool`，把返回值作为 JSON-RPC 响应发回 |
| 连接断开（无法恢复） | `turnCompleted`，`status: 'failed'`，`error.code: 'connection_lost'` |

---

## 9. dsh 只提供模型推理时

如果 dsh 只提供 OpenAI 兼容的推理接口，插件用 `LocalAgentLoop` 自己实现 Agent 循环。

期望 dsh 提供：

| 接口 | 要求 |
| --- | --- |
| `POST /v1/chat/completions` | 支持 `stream: true`（SSE）、`tools` / `tool_calls`；最好支持并行工具调用 |
| `GET /v1/models` | 返回模型列表和上下文长度 |

`LocalAgentLoop` 的流程：

```
messages = [系统提示词, ...历史, 本轮用户输入]
循环（最多 50 步，可配置）：
  1. 流式请求 /chat/completions，文本实时输出为 itemDelta
  2. 没有 tool_calls → 结束本轮
  3. 依次（或并行执行只读工具）调用 ctx.executeTool
  4. 把工具结果作为 tool 消息追加到 messages
  5. 接近上下文上限时，压缩早期的工具输出（保留摘要）
用户中断 → 停止请求，结束本轮（interrupted）
```

插件需要额外维护：

- **系统提示词**：放在插件代码中并做版本管理，说明工具用法、路径约定、输出格式
- **上下文管理**：估算 Token，截断或摘要旧的工具输出
- **防失控**：最大步数、同一工具同一参数连续调用的检测

---

## 10. 断线重连与幂等

- **重连**：指数退避（1s、2s、4s … 上限 30s，带随机抖动）；重连成功后重新 `initialize`
- **进行中的轮次**：
  - dsh 支持 `turnResume` 时：重连后调用 `turn/resume { turnId, lastSeq }`，dsh 从 `lastSeq + 1` 开始补发通知
  - 不支持时：该轮标记为失败（"连接中断"），用户可一键重试
- **通知去重**：插件按 `(turnId, seq)` 丢弃重复或过期通知
- **工具调用幂等**：`callId` 全局唯一；插件缓存最近的工具结果，收到重复的 `callId` 时直接返回缓存结果，**不再重复执行**（避免命令被执行两次）

---

## 11. 版本与兼容

- `protocolVersion` 格式为 `主版本.次版本`
- 次版本只做向后兼容的新增（新字段、新方法、新条目类型）；双方都要**忽略不认识的字段**
- 主版本不一致时，`initialize` 返回错误，插件提示升级
- 插件在日志中记录双方版本，便于排查

---

## 12. Mock 服务

`packages/mock-dsh` 按本文档实现一个本地 WebSocket 服务，用"剧本"驱动，支持流式文本、工具调用、错误注入和断线模拟。剧本示例：

```json
{
  "name": "edit-and-test",
  "steps": [
    { "emit": "agentMessage", "text": "我先看一下现有实现。", "chunkSize": 4, "intervalMs": 30 },
    { "toolCall": "read_file", "arguments": { "path": "src/utils.ts" } },
    {
      "toolCall": "apply_patch",
      "arguments": {
        "changes": [{ "path": "src/utils.test.ts", "type": "add", "content": "// test\n" }]
      }
    },
    { "toolCall": "run_command", "arguments": { "command": "pnpm test" } },
    { "emit": "agentMessage", "text": "测试已通过。" },
    { "complete": { "usage": { "inputTokens": 1200, "outputTokens": 300 } } }
  ]
}
```

其他内置剧本：纯问答、长文本流式、工具执行失败后重试、`-32001` 认证失败、中途断线、限流。

---

## 13. 需要 dsh 服务方提供的信息

对接前请 dsh 服务方确认以下内容（对应 [DESIGN.md 第 2 节](./DESIGN.md#2-关键假设与待确认事项)）：

- [ ] 服务形态：Agent 服务，还是只提供模型推理？
- [ ] 接口文档和**一份真实的请求/响应样例**（包括流式和工具调用）
- [ ] 传输方式：WebSocket / SSE / gRPC / 其他
- [ ] 认证方式和 Token 获取流程
- [ ] 是否支持工具调用，工具定义格式
- [ ] 是否支持会话持久化、轮次断线恢复
- [ ] 模型列表、上下文长度、是否输出推理过程
- [ ] 限流策略、超时设置（特别是 `tool/call` 等待审批时的超时）
- [ ] 部署地址、测试环境、网络要求（代理、证书）
- [ ] 数据合规要求：代码内容能否发送、是否落盘、保留多久
