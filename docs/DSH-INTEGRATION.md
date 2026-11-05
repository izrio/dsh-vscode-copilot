# dsh 对接说明

> 状态：v0.7（M4 已验证）｜ 日期：2026-11-04
>
> 本文记录调研到的 dsh 事实、参考项目的做法、插件与 dsh 的对接细节，以及 M0 的实测结果。设计决策见 [DESIGN.md](./DESIGN.md)。
>
> **基线**
> - dsh：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)。M0 实测了 npm 上的 `0.2.1-rc.5`（`latest`）和 `0.2.2-alpha.3`（`alpha`），源码对照 tag `dsh-v0.2.1-rc.5`
> - 参考项目：[`HarcoChen/dsh-vsc-integration`](https://github.com/HarcoChen/dsh-vsc-integration) `v0.11.1`（2026-10-21），目标 dsh 版本 `0.2.0-rc.2`
>
> 下文路径没有特别说明的都相对于 dsh 仓库根目录。标 **✅ 已验证** 的内容由冒烟测试或端到端测试在真实 dsh 上跑通（[第 9 节](#9-m0-验证结果)）；标 **【待验证】** 的只读过文档或代码。

---

## 目录

1. [dsh 是什么](#1-dsh-是什么)
2. [dsh 的对外入口](#2-dsh-的对外入口)
3. [为什么选 Web Host Remote API](#3-为什么选-web-host-remote-api)
4. [参考项目分析](#4-参考项目分析)
5. [启动、认证与线上格式](#5-启动认证与线上格式)
6. [会用到的 Remote 方法](#6-会用到的-remote-方法)
7. [会话事件模型](#7-会话事件模型)
8. [版本策略](#8-版本策略)
9. [M0 验证结果](#9-m0-验证结果)
10. [M2 验证结果](#10-m2-验证结果)
11. [M3 验证结果](#11-m3-验证结果)
12. [M4 验证结果](#12-m4-验证结果)
13. [参考资料](#13-参考资料)

---

## 1. dsh 是什么

**DeepSeek Harness**（命令名 `dsh`）是 DeepSeek 开源的 Agent 框架，MIT 协议，TypeScript 实现，基于 [Cordis](https://github.com/cordiverse/cordis) 的"一切皆插件"架构。官方文档：<https://deepseek-harness.github.io/deepseek-harness/>。

和插件相关的几个事实：

- **它是完整的 Agent 运行时**：Agent 循环、工具、沙箱、审批策略、会话持久化、上下文压缩、模型适配、凭据、MCP、skill、子 Agent、计划模式、目标模式都在 dsh 内部完成。
- **自带两个面向人的前端**：`dsh web`（浏览器 UI）和 DeepSeek Desktop（Electron 壳，内部是同一个 Host 和同一个 Web 客户端）。Desktop 可以通过菜单「管理 dsh 命令…」把 `dsh` 命令装到系统里，这个命令使用 Desktop 自带的运行时。
- **处于开发者预览阶段**：README 明确写着"未来将出现破坏兼容性的变更"，公开 API 仍处于预稳定阶段。
- **运行时要求 Node ≥ 24.9**（仓库根 `package.json` 的 `engines`）。用 Desktop 自带的 `dsh` 命令则不需要用户自己装 Node。

### 1.1 dsh 已经负责、插件不需要再做的事

| 能力 | dsh 中的位置 |
| --- | --- |
| 读写文件、补丁、搜索 | `read` `write` `edit` `apply_patch` `glob` `grep`（`packages/fs/`） |
| 执行命令、持久终端、后台任务 | `bash` `pwsh` `terminal_*` `job_*`（`packages/shell/`、`terminal/`、`jobs/`） |
| 沙箱与权限预设 | `packages/sandbox/`、`packages/interaction/permission-presets`（预设 `read-only`、`workspace-write`、`danger-full-access`，默认 `workspace-write`） |
| 审批请求 | `packages/interaction/user-approval`，由客户端回答 |
| 向用户提问 | `ask_user_question`，由客户端回答 |
| 计划模式、目标模式、待办 | `exit_plan_mode`、`create_goal`/`update_goal`、`todo_write` |
| 子 Agent、团队任务 | `subagent`、`team_task_*` |
| Web 搜索/抓取 | `web_search`、`web_fetch` |
| 会话持久化、恢复、fork、搜索 | `packages/session/`、`session-query/`，存在 `$DSH_HOME` |
| 上下文压缩 | `packages/compaction/`（`/compact`） |
| 每轮改动记录与对比 | `packages/deliverables/workspace-changes`（git 快照 + 文件副本） |
| 模型目录与选择、API Key、账号 | `packages/llm/`、`credentials/`、`settings/` |

---

## 2. dsh 的对外入口

| 入口 | 传输 | 面向 | 来源 |
| --- | --- | --- | --- |
| `dsh web` | HTTP + WebSocket（Host）+ 浏览器客户端 | 人 | `packages/bundle/web-app`、`packages/host/`、`packages/client/` |
| Desktop | Electron 壳 + 私有 Host + 同一 Web 客户端 | 人 | `apps/desktop` |
| `dsh sdk` | stdio，按行分帧的 JSON-RPC 2.0 | 程序 | `packages/sdk/` |
| `dsh acp` | stdio，Agent Client Protocol | 自动化 | `packages/acp/` |
| `dsh headless` | 一次性 CLI，`--json` 输出事件 | 脚本 | `packages/bundle/headless` |

---

## 3. 为什么选 Web Host Remote API

### 3.1 能力对比

| 能力 | Web Host Remote API | SDK（stdio） | ACP | 嵌入 dsh Web UI |
| --- | --- | --- | --- | --- |
| 逐字流式输出 | ✅ follow 流带逐字帧 | ❌ 只推已持久化事件 | ❌ 只推已提交的语义更新 | ✅ |
| 停止生成 | ✅ | ❌ 协议没有取消，只能杀进程 | ✅ | ✅ |
| 会话列表、搜索、fork | ✅ | ❌（只能 resume 已知 id） | 部分（列出、恢复、关闭） | ✅ |
| 审批 | ✅ | ✅ `approval/request` | 仅一次性机器策略 | ✅ |
| 向用户提问 | ✅ | ✅ `user-question/ask` | ❌ | ✅ |
| 模型目录、权限预设切换 | ✅ | 部分（初始化时定，`/permission` 命令） | 部分 | ✅ |
| 改动汇总与对比 | ✅ | ❌ | ❌ | ✅ |
| 计划审阅、排队消息 | ✅ | 部分 | ❌ | ✅ |
| Codex 风格、跟随 VS Code 主题 | ✅ 自己做 UI | ✅ 自己做 UI | ✅ 自己做 UI | ❌ 是 dsh 自己的界面 |
| 接口稳定性 | ⚠️ 内部预稳定接口 | ⚠️ 预发布，无版本协商 | 标准协议 | — |

### 3.2 不选其他方案的原因

- **SDK**：协议文档（`packages/sdk/protocol/README.zh.md`）的"已知限制"写明**没有取消和会话关闭方法**，客户端放弃轮次的方式是关闭运行时进程；`session.event` 只转发持久事实。架构文档（`docs/architecture.zh.md`）说明逐字流 `agent/assistant-stream` 是进程本地事件，**"Web Session-follow adapter 是该 live event 唯一的远程消费方"**。
- **ACP**：决策记录 `.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md` 明确 ACP **只面向自动化**，已经删掉了早期的编辑器桥接层：没有 token 增量、diff、计划、标题、面向人的询问，并且"不会把 ACP 恢复为 UI"。
- **嵌入 dsh Web UI**：界面不是 Codex 风格，也不跟随 VS Code 主题。浏览器认证 Cookie 是 `SameSite=Strict`，Host 会拒绝 `sec-fetch-site: cross-site` 的请求（`packages/client/connection/README.zh.md`），放在 Webview 的 iframe 里大概率过不了认证。**【待验证】**

### 3.3 选定方案

插件在 **Extension Host（Node）** 里启动 `dsh web`，以 **API 调用方**身份接入它的 Remote API。**✅ 已验证**：M0 在 dsh `0.2.1-rc.5` 和 `0.2.2-alpha.3` 上跑通了连接、逐字流、工具调用、审批、提问和停止（第 9 节）。参考项目 dsh-vsc-integration 走的也是这条路。

---

## 4. 参考项目分析

[`HarcoChen/dsh-vsc-integration`](https://github.com/HarcoChen/dsh-vsc-integration)（MIT，作者另有 JetBrains 版本）是一个功能很全的社区插件。本项目借鉴它验证过的技术做法，但重做界面。

### 4.1 值得借鉴的做法

| 做法 | 说明 | 参考项目中的位置 |
| --- | --- | --- |
| 启动 `dsh --profile web … --no-open --host 127.0.0.1 --port 0` | 启动器参数（如 `--patch`）必须放在 `--no-open` 等应用参数之前 | `src/dshRuntime.ts`、`scripts/verify-remote-runtime.mjs` |
| 从 stdout 用正则解析带 `?token=` 的 URL；日志里把令牌替换成 `<redacted>` | 就绪检测和令牌脱敏 | `src/dshRuntime.ts` |
| 自写 Remote 客户端，只依赖 `ws` | connect、unary、mux、事件、会话状态，约 2700 行 | `src/remote/` |
| 支持一个 dsh 版本范围 | 目标 `0.2.0-rc.2`，最低兼容 `0.1.5-rc.1` | README |
| 优先发现 DeepSeek Desktop 注册的 `dsh` 命令，找不到就引导下载 Desktop | 废弃了自己下载运行时的方案；`pnpm`/`npx` 作为高级用法保留 | `RPC_0.2.0_RC2_ADAPTATION.md` |
| 子进程放进独立进程组，只结束自己启动的进程 | 退出时能清理干净 | `src/runtimeProcess.ts` |
| **从会话日志还原单次工具调用的 Diff** | 文件工具的 `tool/result.meta` 带应用后的改动片段，持久保存在会话日志中；把片段从当前文件反向应用得到改动前内容；片段定位不唯一时放弃还原，不猜测 | `src/toolDiff.ts` |
| 审批前预览将要写入的 Diff | 审批卡片显示命令、工作目录、目标文件 | README |
| 未保存保护 | 目标文件在编辑器里有未保存修改时，不放行写入审批 | README |
| 用临时 `DSH_HOME` + 本地回环的假模型服务做联调 | 不依赖真实 API Key；`$DSH_HOME/settings.yaml` 把 `llm-deepseek.baseURL` 指向本地 | `scripts/verify-remote-runtime.mjs` |
| 斜杠命令实时从 dsh 获取 | `commands/list` 与插件自带命令合并 | README |

### 4.2 不照搬的部分

| 方面 | 参考项目 | 本项目 |
| --- | --- | --- |
| 对话界面 | 角色标签 + trace 链接遍布、每个工具一张大卡片、空占位、两行顶栏、四层底部区域 | 按 [DESIGN.md 3.1](./DESIGN.md#31-界面设计原则) 重新设计 |
| 代码组织 | `chatView.ts` 4513 行、`dshRuntime.ts` 4419 行 | 按模块拆分，单文件尽量不超过 500 行 |
| 功能范围 | Trace 面板、余额、Jev/Laya、调试状态、故障恢复、插件安装、运行时终端、定时任务、Team 等 | 首版只做核心对话体验（[DESIGN.md 1.2](./DESIGN.md#12-首版不做)） |
| 多编辑器共享 Host | 广播文件 + 启动互斥锁，VS Code 和 JetBrains 可共用一个 Runtime | 首版每个窗口一个 Host，后续再评估 |

### 4.3 它反映出的维护成本

参考项目每遇到一个 dsh RC 版本都写一份适配报告（如 `RPC_0.2.0_RC2_ADAPTATION.md`），逐项核对新增或变化的方法、投影结构。例如 RC.2 新增 `userQuestions/answer` 和 `userQuestions/attachWait`；Agent Team 的旧接口被移除，改为只读投影；权限预设的可选项从投影移到了 `permissionPresets/catalog`。

M0 也实测到了一处变化：`0.2.1-rc.5` 只有 `session/page`，`0.2.2-alpha.3` 新增了 `session/events`（master 文档已把 `session/page` 标为弃用）。**协议在持续变化**，必须做好宽松解析、能力探测和多版本测试（第 8 节）。

---

## 5. 启动、认证与线上格式

本节内容都已在 M0 中按真实 dsh 实现并跑通 **✅ 已验证**，代码见 `packages/extension/src/runtime/`、`packages/extension/src/dsh/remote/`。

### 5.1 启动 Host

```bash
dsh --profile web [启动器参数] --no-open --host 127.0.0.1 --port 0
```

| 参数 | 作用 |
| --- | --- |
| `--profile web` | 使用 `web` profile |
| 启动器参数 | 例如测试时的 `--patch <file>`；**必须在应用参数之前** |
| `--no-open` | 不打开浏览器 |
| `--host 127.0.0.1` | 只绑定回环地址 |
| `--port 0` | 系统分配端口，实测可用 |

- **就绪信号**：stdout 打印 `dsh web: http://127.0.0.1:<port>/?token=<token>`，出现这一行就可以发起调用。实测从启动到就绪约 4.5 秒（容器环境）。
- **令牌**：每个进程随机生成，进程重启后就变了；只能保存在内存中，日志统一脱敏。

### 5.2 认证

1. `GET /connect?token=<token>&interactions=answer` → `302`，`Location: ./api/remote.mux`，`Set-Cookie: dsh-auth-<authority>=…; HttpOnly; SameSite=Strict`。
   - 只有 `interactions=answer` 的 Peer 能接收审批、提问等转发事件。
2. 之后的 HTTP 请求和 WebSocket 握手都带 `Cookie: dsh-auth-…=…`。
3. 这条 mux WebSocket 关闭或 Host 重启后，Peer 失效，必须重新 `/connect`。

### 5.3 线上格式

**一元调用**：`POST /api/<namespace>/<method>`，JSON：

```jsonc
// 请求
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/list", "payload": { "args": { "_request": {} } } }
// 响应
{ "type": "server-response", "rpcId": "<同一个 uuid>", "result": { "ok": true, "value": { "items": [] } } }
{ "type": "server-response", "rpcId": "…", "result": { "ok": false, "error": { "code": "session/writer-held", "message": "…", "details": {} } } }
```

- `args` 的键是 Host 方法的**参数名**，各方法的参数名见第 6 节（来自 dsh 生成的 `TYPERT_REMOTE` 描述，例如 `node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.d.ts`）。
- 没有任何插件认领的 endpoint 返回 HTTP 404；方法或服务未挂载时返回 `gateway/method-unavailable` / `gateway/service-unavailable` / `gateway/definition-unavailable`。插件据此做能力探测。
- 带二进制附件的结果是 `multipart/form-data`（M0 未实现，M1 按需补）。

**mux 流**：WebSocket `/api/remote.mux`，每条文本帧一个 JSON：

| 方向 | 帧 |
| --- | --- |
| 客户端 → Host | `{ type: 'open', streamId, endpoint, payload: { args } }`、`{ type: 'item', streamId, value? }`、`{ type: 'end', streamId }`、`{ type: 'cancel', streamId }` |
| Host → 客户端 | `{ type: 'item', streamId, value? }`、`{ type: 'error', streamId, error: { code, message, details } }`、`{ type: 'end', streamId }` |

**转发事件**：打开 endpoint `$events`（`args: {}`）的流：

| 帧 | 含义 |
| --- | --- |
| `{ type: 'ready', clientId, host: { home } }` | 首帧 |
| `{ type: 'emit', event, args }` | 通知，例如 `api-session/added`、`api-session/status`、`api-session/activity` |
| `{ type: 'waterfall', event, eventId, agentId, request }` | 需要回答的请求，例如 `approval/request`、`user-questions/request`；`agentId` 就是 sessionId |
| `{ type: 'cancel', eventId }` | Host 不再等待某个请求 |

回答 waterfall：一元调用 `$events/result`，`args` 为 `{ clientId, eventId, outcome }`，`outcome` 是 `{ kind: 'next' }`（不处理，交给下一个回答方）、`{ kind: 'result', value }` 或 `{ kind: 'rejected', error }`。**每个 waterfall 都必须回答**，否则 Host 会一直等待。

---

## 6. 会用到的 Remote 方法

"参数"列是 `args` 对象的写法。✅ 表示 M0 在 `0.2.1-rc.5` 上调用成功；其余来自参考项目（目标 `0.2.0-rc.2`）和 dsh 文档，用到时再验证。

| 插件功能 | 方法 | 参数 | 状态 |
| --- | --- | --- | --- |
| 注册工作区 | `workspace/create` | `{ request: { path } }` → `{ workspace: { workspaceId, … }, created }` | ✅ |
| 新建会话 | `session/create` | `{ request: { workspaceId, agentPreset? } }` → `{ sessionId }` | ✅ |
| 会话列表 | `session/list` | `{ _request: { cursor? } }` → `{ items: SessionSummary[] }` | ✅ |
| 历史与流式跟随 | `session/follow`（流） | `{ request: { address: { kind: 'session', sessionId }, assistantStream: true, turnWindow: { minMessages: 50, minTurns: 2 } } }` | ✅ |
| 历史分页 | `session/page`（rc.5、alpha.3）/ `session/events`（alpha.3 起） | `{ request: { address, throughSeq, beforeSeq?, maxMessages? } }` | ✅ |
| 发送消息 | `session/prompt` | `{ request: { requestId, sessionId, mode: 'queue' \| 'steer', content: [{ type: 'text', text }] } }` | ✅ |
| 停止 | `session/cancel` | `{ request: { sessionId } }` | ✅ |
| 会话投影 | `session/projections` | `{ request: { sessionId } }` | ✅ |
| 模型目录 | `session/modelCatalog` | `{}` → `{ default, groups: [{ id, name, models }] }` | ✅ |
| 权限预设目录 | `permissionPresets/catalog` | `{}` → `{ options, defaultPreset }` | ✅ |
| 斜杠命令 | `commands/list` | `{ agentId }` | ✅ |
| `@` 文件引用 | `fileReferences/list` | `{ agentId, query }` | ✅ |
| 审批 | `approval/request`（waterfall） | 回答 `{ kind: 'result', value: 'allowed-once' \| 'rejected' \| 'cancelled' }` | ✅ |
| 向用户提问 | `user-questions/request`（waterfall） | 回答 `{ kind: 'result', value: { answers: [{ id, selected: [label], custom? }] } }` | ✅ |
| 会话投影实时更新 | `session/control`（流） | `{}`；先发 `baseline`，之后是 `projection` 更新（两个版本格式不同，见 9.4） | ✅ |
| 排队消息 | `session/updateQueue` | `{ request: { sessionId, itemId, action } }` | |
| 重命名、fork | `session/rename`、`session/fork` | `{ request: { sessionId, … } }` | |
| 选择模型 | `session/selectModel` | `{ request: { sessionId, provider, model, reasoningEffort? } }` | |
| 搜索 | `session/search` | `{ request: { query } }` | |
| skill | `skills/list` | `{ request: { sessionId } }` | |
| 超时后的问题 | `userQuestions/answer`、`userQuestions/attachWait` | 参考项目 RC.2 适配报告 | |
| 每轮改动 | `workspace/changes` 事件 + 摘要/对比接口 | Remote 方法名 **【待验证】**（`client/ui-deliverables` 的 Host 端） | |
| 读取工作区文件 | `workspaceFiles/list` `stat` `read` `readBytes` `changes` | | |
| API Key | `credentials/describe`、`credentials/set`、`credentials/unset` | | |

**审批请求的内容**（✅ 实测）：

```json
{ "toolName": "bash", "callId": "toolu_…", "reason": "escalate sandbox to danger-full-access: …",
  "displayReason": { "en": "Allow this operation with danger-full-access permissions: …", "zh": "允许本次操作使用 danger-full-access 权限：…" } }
```

**什么时候会审批**（✅ 实测）：默认预设 `workspace-write` 下，工作区内的读写和普通命令**不触发审批**；模型调用 `bash`/`write` 等时带上 `sandbox_permissions: 'danger-full-access'` 和 `justification` 请求越过沙箱，才会发 `approval/request`（`packages/sandbox/sandbox/src/escalation.ts`）。被拒绝时，工具结果是 `isError: true` 的说明文字，模型会停下来解释。

---

## 7. 会话事件模型

### 7.1 持久事件

来自 `packages/core/session/src/types.ts` 的 `SessionEventMap`，其他包还会扩展更多事件类型。持久事件的线上结构是 `{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`，`seq` 在会话内连续递增（✅ 实测）。

| 事件 | 含义 |
| --- | --- |
| `turn/start`、`turn/end`（带 `reason`） | 一轮开始/结束；用户停止时 `reason` 为 `{ kind: 'aborted', reason: { kind: 'user' } }` ✅ |
| `step/start`、`step/end` | 一步（一次模型请求加它调用的工具） |
| `user/message` | 用户消息；**一轮里会有多条**：用户真正发的那条 `source` 为 `{ kind: 'user', rpcId }`，`rpcId` 等于发送时的 `requestId` ✅；其余是 dsh 注入的运行时上下文（`source.kind` 如 `runtime-context`），界面不展示 |
| `assistant/message` | 助手完整消息：`{ turn, step, message, usage, stream }` ✅ |
| `assistant/attempt` | 失败、重试、取消的尝试（不进入模型历史） |
| `tool/call` | `{ turn, step, callId, name, arguments }`，`arguments` 是 JSON 字符串 ✅ |
| `tool/result` | `{ turn, step, message: { toolCallId, content, isError }, error?, meta? }` ✅ |
| `approval/asked`、`approval/decided` | 审批的审计记录 ✅ |
| `job/registered`、`job/settled` | bash 命令作为后台任务登记与结束 ✅ |
| `workspace/changes` | 本轮改动摘要已生成，只带 `{ turn }` ✅ |
| `session/title` 等 | 标题生成 |
| `system/message`、`developer/message`、`request/*`、`agent/inbox/spliced`、`session-log-deepseek/*` | 内部事件，界面不展示 |

### 7.2 follow 流

`session/follow` 的帧（✅ 实测，`packages/api/session-controller/src/types.ts` 的 `SessionFollowFrame`）：

| 帧 | 内容 |
| --- | --- |
| `{ type: 'snapshot', header, cursor, records, hasMore, projections, assistantStream? }` | 开场快照；`assistantStream.activeAttempt` 是正在进行的输出（紧凑记录：`text-chunks`、`reasoning-chunks`、`tool-call-chunks`，文本以数组存放） |
| `{ type: 'event', event }` | 一条持久事件 |
| `{ type: 'assistant-stream', frame }` | 逐字流：`start { attemptId, revision, turn, step, startedAfterSeq }`、`chunk { attemptId, index, chunk }`、`end { attemptId, outcome: committed \| abandoned }` |

- `chunk.chunk` 是原始流片段：`block-start`、`text-delta { index, text }`、`reasoning-delta`、`tool-call-delta { index, id, name?, argumentsDelta }`、`block-end`、`usage`、`finish`。
- 逐字帧的 `index` 连续递增；不连续时要重新打开 follow。
- 插件的实现在 `packages/extension/src/dsh/session/journal.ts`，规则对照官方 `packages/api/session-controller/src/client/sessions/assistant-stream.ts`：
  - 与当前流式尝试匹配的 `assistant/message` / `assistant/attempt`（seq 晚于 `startedAfterSeq`、轮次和步骤相同）先暂存，等 `end` 帧确认后再发布，同时撤掉临时文本；
  - `start` 时还有未结算的内容、`revision` 跳号（同一个 follow 内逐帧加一）、下标跳号、`end` 对不上暂存的事件，都重新打开 follow；
  - 与官方的一处差别：官方把成功消息的临时行保留到 `step/end`（给它的工具卡片用），插件从持久消息渲染工具调用，在 `end` 时直接撤掉；
  - 没收到 `end` 帧时，暂存的结算在本步或本轮结束时一并发布，作为安全网。
- 开场窗口：首次 follow 要带 `turnWindow`（官方客户端用 `{ minMessages: 50, minTurns: 2 }`），否则 0.2.2-alpha 起只给最近一小段历史。

### 7.3 改动数据

| | 单次工具调用（`tool/result.meta`） | 每轮汇总（`workspace/changes`） |
| --- | --- | --- |
| 结构 | `{ operation?, path, diffs: [{ path, oldText, newText }] }` ✅ | 事件只带 `{ turn }`，摘要和单文件对比由 Host 的 HTTP 接口提供（见 10.1）✅ |
| 覆盖范围 | 文件工具（`write`、`edit`；0.2.1-rc.5 的文件工具里没有 `apply_patch`）✅ | 本轮所有改动，含 shell 命令造成的改动（需要 git） |
| 新建文件 | `operation: 'create'`，`diffs: []`；改动后的内容就是 `tool/call` 参数里的 `content` ✅ | |
| 修改文件 | 每个片段带三行上下文；纯插入时 `oldText` 为 `null`；**没有行号，也没有完整的改动前文件** ✅ | 带三行上下文的片段 |
| 路径 | 绝对路径 ✅ | 工作区内为相对路径 |
| 持久性 | 写在会话日志里，长期可用 | 只在 Host 内存中；Host 重启后之前轮次的都没了 |

补充：
- 界面上的"diff 卡片"（`card: 'diff'`）是 dsh 展示层根据 `meta` 和工具参数**临时算出来的**，不会持久化（`packages/fs/tool-fs/src/write.ts`）。
- dsh 要求**修改文件前必须先读过**，否则工具返回 `FS_NOT_OBSERVED` 错误 ✅。这是 dsh 自己的规则，插件不用处理，但假模型脚本要先 `read` 再 `edit`。

---

## 8. 版本策略

- **支持范围**：最低 `0.2.1-rc.5`，已测试到 `0.2.2-alpha.3`（`packages/extension/src/runtime/version.ts`）。更早的版本没有测过，暂不支持；需要时再往下扩。
- **启动检查**：执行 `dsh --version`。低于最低版本时提示升级，不启动；高于已测试的最高版本时照常启动，并提示"版本较新"。
- **宽松解析**：入站数据用 zod 校验必需字段，未知字段保留或忽略，未知事件跳过，单条数据解析失败只影响这一条，并写调试日志。
- **能力探测**：调用返回"方法不存在"时记录下来，界面隐藏对应功能，不报错。已用它区分 `session/page` 和 `session/events`。
- **格式兼容**：同一个方法在不同版本的返回格式不同时，在 `DshClient` 里统一成一种（例如 9.4 里 `session/control` 的两种更新格式）。
- **多版本测试**：工作流 `.github/workflows/dsh-compat.yml` 每天用最低版本、`latest`、`alpha` 三个 dsh 版本跑冒烟测试。
- **跟进变化**：关注 dsh 的 release notes 和仓库中 `.agents/notes/` 下的决策记录；参考项目的适配报告也是有用的信号。

---

## 9. M0 验证结果

### 9.1 环境与方法

- dsh `0.2.1-rc.5`（npm `latest`）和 `0.2.2-alpha.3`（npm `alpha`），Node 24.22，Linux 容器
- 临时 `DSH_HOME` 和临时 git 工作区，不读取任何用户数据
- 模型使用本地假模型（`packages/extension/test/mock-model/server.ts`，兼容 Anthropic Messages API），由 `$DSH_HOME/settings.yaml` 的 `llm-deepseek.baseURL` 指过去，不需要真实 API Key
- 冒烟脚本：`packages/extension/scripts/m0-smoke.ts`，使用插件自己的 `RuntimeManager` 和 `DshClient`

```bash
pnpm smoke -- --dsh "$(command -v dsh)" --report smoke-report.json
```

### 9.2 结果

两个版本都是 **31/31 项通过**：

| 场景 | 验证内容 |
| --- | --- |
| 启动 | 定位 dsh、版本检查、启动、从 stdout 解析 URL 和令牌 |
| 连接 | `/connect` → Cookie → mux WebSocket → `$events` ready |
| 会话 | `session/list`、`workspace/create`、`session/create`、`session/follow` 开场快照 |
| hello | 逐字流（`start`/`chunk`/`end`）拼出完整回复，随后收到 `assistant/message` |
| write | 新建文件写入工作区；`tool/result.meta` 为 `{ operation: 'create', diffs: [] }`；收到 `workspace/changes` |
| edit | 先 `read` 再 `edit`；`meta.diffs` 带 `oldText`/`newText` |
| bash | 工作区内命令直接执行，不触发审批 |
| approval-allow | 请求 `danger-full-access` 的命令触发 `approval/request`，回答"允许一次"后执行 |
| approval-reject | 回答"拒绝"后命令不执行，工具结果为错误说明 |
| ask | `ask_user_question` 触发 `user-questions/request`，回答进入工具结果 |
| cancel | 流式输出中途 `session/cancel`，轮次以"用户中止"结束，临时文本清除 |
| 能力探测 | rc.5：`session/events` 不可用；alpha.3：`session/page` 和 `session/events` 都可用；其余探测方法都可用 |

每个场景收到的 follow 帧已录制为 fixture（`packages/extension/test/fixtures/m0/`，临时路径和端口已替换成占位符），单元测试用它们回放。

### 9.3 留给后续里程碑确认的事项

| 事项 | 状态 |
| --- | --- |
| follow 流完整结算语义（对照 `SessionEventStream`），断线重连与缺口修复 | ✅ M1 完成 |
| 在真实 VS Code 中加载插件 | ✅ M1 完成：用 code-server 4.144（VS Code 1.144）验证，脚本 `packages/extension/scripts/vscode-e2e.ts` |
| 多个 VS Code 窗口各启动一个 Host、与用户自己的 `dsh web` 同时运行 | ✅ M1 完成：可以并存，见 9.4 |
| `workspace/changes` 摘要和单文件对比的 Remote 方法名 | M2 |
| `apply_patch` 的 `meta` 是否也带 `diffs` | M2 |
| Windows（`dsh.cmd`、进程树结束）和 macOS | M5 |
| GitHub Actions 上沙箱（bwrap 等）能否正常工作，决定兼容测试能否稳定运行 | 首次运行 `dsh-compat` 工作流时 |

### 9.4 M1 新发现

| 主题 | 发现 | 插件的处理 |
| --- | --- | --- |
| 会话投影 | 会话列表的每一项自带缓存的投影 `projections.values`：`title`、`modelSelection`（`lastUsed` / `next`）、`contextPressure`（`pressureTokens` / `contextWindow`）、`inbox`、`todos`、`permissions`、`plan`、`turnOutline`、`tokenUsage` 等；follow 的开场快照也带一份 | 标题、当前模型、上下文用量直接用投影 |
| `session/control` 更新格式 | 0.2.1-rc.5：`{ type: 'projection', sessionId, key, value, seq }`；0.2.2-alpha.3：`{ type: 'projection', sessionId, seq, changes: [{ key, val }] }`（一个事件引起的一批变化） | `DshClient.control()` 统一成批量格式，两种都有单元测试 |
| follow 开场窗口 | 不带 `turnWindow` 时，0.2.2-alpha.3 只给最近一小段历史（切回旧会话时第一轮回复不在快照里） | 首次 follow 带 `turnWindow: { minMessages: 50, minTurns: 2 }`，与官方一致 |
| 会话列表的 `running` | 靠 `api-session/*` 通知触发刷新，比 follow 里的 `turn/end` 晚到 | 当前会话以事件日志为准（`scripts/ui-e2e.ts` 的停止场景覆盖） |
| 多个 Host 并存 | 两个 Host 共用同一个 `DSH_HOME` 和 `web` profile 可以同时运行；B 能列出、能 follow（只读）A 的会话，但向它发消息返回 `session/writer-held`；A 退出后 B 可以接手（`scripts/concurrency-check.ts`） | 每个窗口一个 Host 的方案可行；`session/writer-held` 翻译成"这个会话正在另一个窗口或 dsh Web UI 中使用" |
| 没有 API Key | 消息照常被接收，轮次以 `turn/end.reason = { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } }` 结束，错误信息是英文技术描述 | 显示中文提示和"打开 dsh 设置"入口（在 dsh Web UI 的模型页面填写） |
| 远程场景的设置 | code-server、Remote-SSH 下插件运行在远端，`machine-overridable` 范围的 `dsh.runtime.path` 从远端的 `Machine/settings.json` 读取，写在用户设置里不生效 | 符合 VS Code 的设计，保留该范围；文档和测试脚本里说明 |
| Webview 的 CSP | 不开 `'unsafe-inline'` 时，通过 `innerHTML` 插入的内联 `style` 属性会被拦截（shiki 的 HTML 输出因此没有颜色）；只在真实 VS Code 里才能发现 | 代码高亮改成输出 token、用 React 渲染；界面端到端测试使用与生产相同的 CSP，并检查颜色是否真的生效 |
| 停止生成后保存的内容 | 被中断的 `assistant/message` 带 `interrupted: true`，内容是中断时已经输出的部分 | 显示部分回复，并追加"已停止生成" |

---

## 10. M2 验证结果

在 `0.2.1-rc.5` 和 `0.2.2-alpha.3` 上用 `scripts/ui-e2e.ts`（50 项）验证，`0.2.1-rc.5` 上另用 code-server 跑 `scripts/vscode-e2e.ts`（13 项）。

### 10.1 接口

| 用途 | 接口 | 参数 | 返回 |
| --- | --- | --- | --- |
| 审批 | `$events` waterfall `approval/request` | `{ toolName, callId?, reason?, displayReason?: { en, zh } }` | `{ kind: 'result', value: 'allowed-once' \| 'rejected' }`（dsh 还接受 `cancelled` / `unavailable`） |
| 提问 | `$events` waterfall `user-questions/request` | `{ questions: [{ id, question, header?, detail?, options?: [{ label, description? }], multiSelect? }] }` | `{ kind: 'result', value: { answers: [{ id, selected: string[], custom? }] } }` 或 `{ cancelled: true }` |
| 权限目录 | `permissionPresets/catalog` | `{}` | `{ options: [{ value, name }], defaultPreset }` |
| 切换权限 | `commands/execute` | `{ agentId, line: '/permission <预设>', submittedAttachments: [] }` | `{ commandId, result: { kind: 'success', text } }`；当前值在投影 `permissions.currentValue` |
| 本轮改动摘要 | `GET /api/changes.summary?sessionId=&seq=`（带认证 Cookie，`seq` 是 `workspace/changes` 事件的序号） | — | `{ turn, files: [{ path, display, added, deleted, binary?, oversized? }], total, added, deleted }` |
| 本轮单文件对比 | `GET /api/changes.diff?sessionId=&seq=&index=` | — | `{ kind: 'text', path, before, after, hunks: [{ oldStart, oldLines, newStart, newLines, lines: [' 上下文', '-旧', '+新'] }], coarse }`；二进制、过大文件 `kind` 为 `binary` / `oversized` |

两个 changes 接口不是 Remote 方法，是普通的 HTTP GET；Host 重启后返回 404。

### 10.2 发现

| 主题 | 发现 | 插件的处理 |
| --- | --- | --- |
| 审批请求的内容 | 只有工具名、`callId` 和原因，没有命令或文件路径；`tool/call` 事件先于审批持久化 | 用 `callId` 在会话日志里找 `tool/call` 参数，显示命令或文件 |
| 审批原因 | `reason` 是英文（`escalate sandbox to danger-full-access: <justification>`），`displayReason.zh` 是中文 | 优先 `displayReason.zh` |
| 提问的投影 | 0.2.1-rc.5 默认阻塞模式：等待回答期间 `userQuestions` 投影的 `active` 一直为空 | 只靠 waterfall；不做"超时后延迟回答" |
| 提问结果 | `tool/result` 的内容是回答的 JSON | 活动行显示"回答：…" |
| `edit` 的片段 | `oldText` / `newText` 带上下文，最后一行通常没有换行符 | 统计增删行数前补齐结尾换行，否则最后一行会被算成修改 |
| 本轮 hunk | 与 unified diff 一致：新建文件 `oldLines: 0`，删除的文件 `after: false` | 从当前文件逐行核对后反向应用；新建/删除分别用空文档做一侧 |
| Host 重启 | 新 Host 使用新端口；之前轮次的 changes 接口返回 404，`tool/result.meta` 仍在会话日志里 | origin 变化时清掉缓存，404 时卡片退回按文件工具汇总，Diff 用会话日志里的片段 |

---

## 11. M3 验证结果

在 `0.2.1-rc.5` 和 `0.2.2-alpha.3` 上用 `scripts/ui-e2e.ts`（66 项）验证；`0.2.1-rc.5` 上另用 code-server 跑 `scripts/vscode-e2e.ts`（16 项），右键菜单发出的消息直接在假模型那一端检查。

### 11.1 接口

| 用途 | 方法 | 参数 | 返回 |
| --- | --- | --- | --- |
| 斜杠命令目录 | `commands/list` | `{ agentId }` | `[{ definitionId, name, description, input?: { hint, attachments? } }]`；0.2.1-rc.5 有 `compact`、`export`、`feedback`、`goal`、`permission`、`plan` |
| 执行命令 | `commands/execute` | `{ agentId, line: '/compact', submittedAttachments: [] }` | `{ commandId, result: { kind: 'success' \| 'error', text, sourceEventSeq? } }` |
| `@` 候选 | `fileReferences/list` | `{ agentId, query }`（`@` 后面的文本；以 `/` 结尾时列目录内容） | `[{ path, kind: 'file' \| 'directory' }]`，按相关度排序，空查询给出顶层 |

### 11.2 发现

| 主题 | 发现 | 插件的处理 |
| --- | --- | --- |
| prompt 的内容 | `session/prompt` 的 `content` 只有 `text` 和 `image`；dsh 没有"附带文件"的概念 | 上下文作为 `<ide_context>` 块拼在文本末尾，显示时解析掉（参考项目也是这样做的） |
| `@` 引用 | 纯文本约定：dsh 在系统提示里告诉模型"`@` 开头的是用户引用的路径，需要时用 read 读取"；语法 `@path` / `@"带空格"`，目录以 `/` 结尾（`packages/context/file-reference/src/grammar.ts`） | 补全和显示都按同一语法 |
| `fileReferences/list` 需要会话 | 参数是 `agentId`，新对话还没有会话 | 新对话用 VS Code 的文件搜索 |
| 命令留在会话日志里 | 执行命令会持久化 `command/run { commandId, name, args, source }` 和 `command/done { commandId, kind, text }`；不产生 `user/message` | 渲染成一行，历史里也能看到 |
| `/compact` | 产生 `compaction/*` 事件和一条检查点 `user/message`（`source.kind` 不是 `user`） | 检查点消息不显示 |
| `/plan` | 产生 `plan/mode { active }`，投影 `plan: { active, pending }` | 输入框显示"计划模式"，点击发送 `/plan off` |
| `/export` | 只是请求浏览器下载会话日志 | 不在 VS Code 里列出 |
| 命令的文字 | `command/done.text` 是英文 | 原样显示（`/permission` 除外，翻译成中文提示） |

---

## 12. M4 验证结果

在 `0.2.1-rc.5` 和 `0.2.2-alpha.3` 上用 `scripts/ui-e2e.ts`（87 项）验证，探针脚本记录了下面的线上格式。

### 12.1 接口与投影

| 用途 | 接口 | 格式 |
| --- | --- | --- |
| 排队消息 | 投影 `inbox` | `{ 'next-turn': [msg], 'next-step': [msg] }`，`msg = { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }`；`rpcId` 就是 `session/prompt` 的 `requestId` |
| 修改队列 | `session/updateQueue` | `{ request: { sessionId, itemId, action } }`，`action` 为 `{ kind: 'edit', content: [TextBlock] }` / `{ kind: 'remove' }` / `{ kind: 'steer' }`；返回 `{ accepted: true }`。每次修改持久化一个 `agent/inbox/spliced` 事件 |
| 计划审阅 | `$events` waterfall `user-questions/request` | 问题 `{ id: 'plan-review', header: 'Plan review', question, detail: <计划 Markdown>, options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve', callId } }`。批准：`{ answers: [{ id: 'plan-review', selected: ['Approve'] }] }`；继续完善：选另一个选项，反馈放在 `custom`（带了 `custom` 就不算批准）；取消：dsh 结束本轮 |
| 计划模式 | 投影 `plan` | `{ active, pending }`；`/plan` 和批准计划都会产生 `plan/mode { active }` |
| 待办 | 投影 `todos` | `[{ content, status: 'pending' \| 'in_progress' \| 'completed' }]` 或 `null`；来自 `todo_write` 的 `todo/write` 事件，整表替换 |
| 目标 | 投影 `goal` | `{ goal: { id, revision, objective, phase: 'active' \| 'paused' \| 'blocked' \| 'complete', blockedReason?, maxGoalRounds }, roundsStarted, createdAt, updatedAt }` 或 `null` |
| 重命名 | `session/rename` | `{ request: { sessionId, title } }` → `{ title, seq }`（标题由 dsh 规范化） |
| 搜索 | `session/search` | `{ request: { query } }`；默认部署返回 `gateway/internal: session search is disabled`（`session-query` 的 `openAt` 为 `never`） |
| 凭据 | `credentials/describe` / `set` / `unset` | `describe { refs }` → `{ [ref]: { configured, source?, writable } }`；`set { ref, value }`；值只往 dsh 方向传 |

### 12.2 发现

| 主题 | 发现 | 插件的处理 |
| --- | --- | --- |
| 停止生成与队列 | `session/cancel` 保留队列，但不会自己开始新的一轮；插队（`next-step`）的消息也留在队列里，等下一条消息发送时一起送达 | 停止后排队的消息显示"还没发出"，提供"现在发送"（取出后作为新消息发送） |
| 本地回显与队列 | 消息进入队列后，如果被删除，就不会出现在历史里 | 进入队列后立即撤掉本地回显，避免删除后又冒出来 |
| 没有 API Key | 模型目录的 `groups` 为空；轮次以 `MISSING_CREDENTIAL` 结束，消息里写明要配置的凭据名（"store DSH_TEST_API_KEY through the credentials service"） | 目录为空时显示配置引导；凭据名从错误消息里取，默认 `DEEPSEEK_API_KEY` |
| 凭据名 | `settings/describe` 里 `llm-deepseek` 的 `apiKeyEnv` 显示的是默认值，不反映 `settings.yaml` 里改过的值 | 不用它判断凭据名 |
| 保存凭据 | `credentials/set` 后立即生效：重新读模型目录就有模型，下一轮对话正常，不需要重启 dsh | 保存后重新读取模型目录 |
| `exit_plan_mode` 的结果 | 批准：内容 "Plan approved …"；继续完善：工具以错误返回 "The user chose to keep planning …"；不在计划模式时调用也是错误 | 按内容区分，只有"继续完善"不算失败 |

---

## 13. 参考资料

**dsh 仓库**：

| 主题 | 路径 |
| --- | --- |
| 项目说明 | `README.zh.md` |
| 架构（profile、事件、轮次流程） | `docs/architecture.zh.md` |
| CLI 帮助 | `docs/cli-help.zh.md` |
| Web 应用组合包（启动 URL、就绪信号） | `packages/bundle/web-app/README.zh.md` |
| 连接与认证、一元调用信封 | `packages/client/connection/src/{browser-auth.ts,rpc-schema.ts,client/rpc.ts}` |
| mux 与转发事件 | `packages/api/gateway/src/stream-protocol.ts`、`packages/api/gateway/src/client/remote-events.ts` |
| 转发事件清单 | `packages/api/remotes/src/remote-events.ts` |
| 会话控制器（请求类型、follow 帧） | `packages/api/session-controller/src/types.ts`、`README.zh.md` |
| 流片段类型 | `packages/llm/llm/src/{types.ts,assistant-stream.ts}` |
| 审批 | `packages/interaction/user-approval/src/types.ts`、`packages/sandbox/sandbox/src/escalation.ts` |
| 提问 | `packages/interaction/user-questions/src/types.ts` |
| 文件工具的 diff 元数据 | `packages/fs/tool-fs/src/{write.ts,diff.ts}` |
| 改动记录 | `packages/deliverables/workspace-changes/README.zh.md` |
| 权限预设 | `packages/interaction/permission-presets/README.zh.md` |
| Desktop（`dsh` 命令、版本锁定） | `apps/desktop/README.zh.md` |
| SDK 协议 | `packages/sdk/protocol/README.zh.md`、`packages/sdk/server/README.zh.md` |
| ACP 定位 | `.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md` |
| 工具目录 | `docs/tool-catalog.zh.md` |

**参考项目**（`v0.11.1`）：

| 主题 | 路径 |
| --- | --- |
| 功能说明 | `README.zh-CN.md` |
| 协议客户端 | `src/remote/` |
| 运行时启动与发现 | `src/dshRuntime.ts`、`src/runtimeProcess.ts` |
| Diff 还原 | `src/toolDiff.ts` |
| dsh 版本适配记录 | `RPC_0.2.0_RC2_ADAPTATION.md` |
| 联调脚本 | `scripts/verify-remote-runtime.mjs` |
