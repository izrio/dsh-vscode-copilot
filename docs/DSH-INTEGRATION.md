# dsh 对接说明

> 状态：v0.2 ｜ 日期：2026-11-04
>
> 本文记录调研到的 dsh 事实、参考项目的做法，以及插件与 dsh 的具体对接方式。设计决策见 [DESIGN.md](./DESIGN.md)。
>
> **调研基线**
> - dsh：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) master `8bd0733`（2026-11-03，仓库版本 `0.2.2-alpha.3`）；npm 上 `@deepseek-ai/dsh` 的 `latest` 为 `0.2.1-rc.5`，`alpha` 为 `0.2.2-alpha.3`
> - 参考项目：[`HarcoChen/dsh-vsc-integration`](https://github.com/HarcoChen/dsh-vsc-integration) `v0.11.1`（2026-10-21），目标 dsh 版本 `0.2.0-rc.2`
>
> 下文"来源"中的路径，没有特别说明的都相对于 dsh 仓库根目录。标注 **【待验证】** 的内容只读过文档或代码，没有实际跑通，需要在 M0 中确认。

---

## 目录

1. [dsh 是什么](#1-dsh-是什么)
2. [dsh 的对外入口](#2-dsh-的对外入口)
3. [为什么选 Web Host Remote API](#3-为什么选-web-host-remote-api)
4. [参考项目分析](#4-参考项目分析)
5. [启动、认证与连接](#5-启动认证与连接)
6. [会用到的 Remote 方法](#6-会用到的-remote-方法)
7. [会话事件模型](#7-会话事件模型)
8. [版本策略](#8-版本策略)
9. [M0 技术验证清单](#9-m0-技术验证清单)
10. [参考资料](#10-参考资料)

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
| 沙箱与权限预设 | `packages/sandbox/`、`packages/interaction/permission-presets`（默认预设 `workspace-write`、`danger-full-access`） |
| 审批请求 | `packages/interaction/`，由客户端回答 |
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
| 逐字流式输出 | ✅ follow 流带 live chunk | ❌ 只推已持久化事件 | ❌ 只推已提交的语义更新 | ✅ |
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

插件在 **Extension Host（Node）** 里启动 `dsh web`，以 **API 调用方**身份接入它的 Remote API，能力与 dsh Web UI 一致。

可行性有两方面依据：

- dsh 自己有同类用法的测试：`packages/api/gateway/tests/authenticated-node.client.spec.ts`（"authenticated Node Client"）
- 参考项目 dsh-vsc-integration 用的就是这条路，已经发布到 v0.11.1（见第 4 节）

---

## 4. 参考项目分析

[`HarcoChen/dsh-vsc-integration`](https://github.com/HarcoChen/dsh-vsc-integration)（MIT，作者另有 JetBrains 版本）是一个功能很全的社区插件。本项目借鉴它验证过的技术做法，但重做界面。

### 4.1 值得借鉴的做法

| 做法 | 说明 | 参考项目中的位置 |
| --- | --- | --- |
| 启动 `dsh web --no-open --port <port>` | 用 `web` profile；插件先挑一个空闲端口传进去 | `src/dshRuntime.ts` |
| 从 stdout 用正则解析带 `?token=` 的 URL；日志里把令牌替换成 `<redacted>` | 就绪检测和令牌脱敏 | `src/dshRuntime.ts` |
| 自写 Remote 客户端，只依赖 `ws` | connect、unary、mux、事件、会话状态，约 2700 行 | `src/remote/` |
| 支持一个 dsh 版本范围 | 目标 `0.2.0-rc.2`，最低兼容 `0.1.5-rc.1` | README |
| 优先发现 DeepSeek Desktop 注册的 `dsh` 命令，找不到就引导下载 Desktop | 废弃了自己下载运行时的方案；`pnpm`/`npx` 作为高级用法保留 | `RPC_0.2.0_RC2_ADAPTATION.md` |
| 子进程放进独立进程组，只结束自己启动的进程 | 退出时能清理干净 | `src/runtimeProcess.ts` |
| **从会话日志还原单次工具调用的 Diff** | `write`/`edit`/`str_replace_editor` 的结果带 `card: 'diff'` 展示数据（应用后的片段，三行上下文），持久保存在会话日志中；把片段从当前文件反向应用得到改动前内容；片段定位不唯一时放弃还原，不猜测 | `src/toolDiff.ts` |
| 审批前预览将要写入的 Diff | 审批卡片显示命令、工作目录、目标文件 | README |
| 未保存保护 | 目标文件在编辑器里有未保存修改时，不放行写入审批 | README |
| 用临时 `DSH_HOME` + 本地回环的假模型服务做联调 | 不依赖真实 API Key | `RPC_0.2.0_RC2_ADAPTATION.md`、`scripts/verify-remote-runtime.mjs` |
| 斜杠命令实时从 dsh 获取 | `commands/list` 与插件自带命令合并 | README |

### 4.2 不照搬的部分

| 方面 | 参考项目 | 本项目 |
| --- | --- | --- |
| 对话界面 | 角色标签 + trace 链接遍布、每个工具一张大卡片、空占位、两行顶栏、四层底部区域 | 按 [DESIGN.md 3.1](./DESIGN.md#31-界面设计原则) 重新设计 |
| 代码组织 | `chatView.ts` 4513 行、`dshRuntime.ts` 4419 行 | 按模块拆分，单文件尽量不超过 500 行 |
| 功能范围 | Trace 面板、余额、Jev/Laya、调试状态、故障恢复、插件安装、运行时终端、定时任务、Team 等 | 首版只做核心对话体验（[DESIGN.md 1.2](./DESIGN.md#12-首版不做)） |
| 多编辑器共享 Host | 广播文件 + 启动互斥锁，VS Code 和 JetBrains 可共用一个 Runtime | 首版每个窗口一个 Host，后续再评估 |

### 4.3 它反映出的维护成本

参考项目每遇到一个 dsh RC 版本都写一份适配报告（如 `RPC_0.2.0_RC2_ADAPTATION.md`），逐项核对新增或变化的方法、投影结构。例如：

- RC.2 新增 `userQuestions/answer` 和 `userQuestions/attachWait`，超时后的问题改为通过 `userQuestions` 投影保留并延迟回答
- Agent Team 的旧接口 `agentTeams/view|createTask|updateTask` 被移除，改为只读投影
- 权限预设的可选项从投影移到了独立的 `permissionPresets/catalog`

另外，dsh master 的会话控制器文档已经把 `session/page` 标为弃用，改用 `session/events`。这说明**协议在持续变化**，必须做好宽松解析、能力探测和多版本测试（第 8 节）。

---

## 5. 启动、认证与连接

### 5.1 启动 Host

```bash
dsh web --no-open --port <端口>
```

| 参数 | 作用 |
| --- | --- |
| `web` | 启动 `web` profile（等同于 `--profile web`） |
| `--no-open` | 不打开浏览器 |
| `--port` | 监听端口；也可以传 `0` 让系统分配，M0 确认哪种方式更稳 |
| 默认绑定 | `127.0.0.1`，不暴露到网络 |

**就绪信号**：Host 就绪后在 stdout 打印带启动令牌的 URL，形如 `http://127.0.0.1:<port>/?token=<token>`。web-app 文档说明这一行就是就绪信号："监督方一观察到该行就发起 RPC"（`packages/bundle/web-app/README.zh.md`）。参考项目用的正则：

```
https?:\/\/(?:\[[0-9a-f:.]+\]|localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:\/(?:\?token=[A-Za-z0-9_-]+)?)?
```

**令牌**：每个进程随机生成一个，进程重启后就变了。令牌是进程凭据，不能写日志，不能显示在界面上。

### 5.2 认证与连接

依据 `packages/client/connection/README.zh.md` 的"浏览器认证与请求信任"一节：

1. **建立 API Peer**：`GET /connect?token=<token>&interactions=answer`，返回 302、Mux 目标地址和签名的 API Cookie。
   - `interactions=answer` 才能接收审批、提问等转发事件；不带时默认 `none`，这类事件收不到（订阅时会报 `gateway/interactions-forbidden`）。
2. **一元调用**：HTTP POST `/api`，带上 API Cookie。
3. **流**：WebSocket `/api/remote.mux`，带上同一个 Cookie。
4. **生命周期**：这条 API WebSocket 关闭或 Host 重启后，Peer 就被移除，之后用这个 Cookie 的请求都会被拒绝，必须重新走 `/connect`。
5. **信任检查**：请求的 `Host` 头必须是 loopback 或绑定地址；插件只连 `127.0.0.1`，满足要求。

### 5.3 客户端实现

按 [DESIGN.md D5](./DESIGN.md#d5-自写精简-remote-客户端兼容一个版本范围)，插件**自己实现**精简客户端，只依赖 `ws`。需要实现的部分，以及可以对照的官方实现：

| 部分 | 内容 | 官方实现（行为参考） |
| --- | --- | --- |
| connect | `/connect` 握手、Cookie 管理、令牌脱敏 | `packages/client/connection` |
| unary | `POST /api` 请求/响应信封、错误码、multipart 附件结果 | `packages/client/connection`、`packages/api/gateway` |
| mux | WebSocket 帧格式、逻辑流的打开/上行/半关闭/取消、`$events` ready、转发事件订阅 | `packages/api/gateway`（`./stream-protocol`） |
| follow | 历史分页 + follow 开场快照、live chunk、`replace`/`prepend`/`append`/`settle-assistant`、序号缺口修复、重连 | `packages/api/session-controller` 的 `SessionEventStream` |

dsh 和参考项目都是 MIT 协议；借鉴代码时在文件头保留原版权声明。

---

## 6. 会用到的 Remote 方法

方法名来自参考项目（目标 dsh `0.2.0-rc.2`）和 dsh master 的各包 README；以 M0 实测的版本为准 **【待验证】**。

| 插件功能 | Remote 方法 / 事件 |
| --- | --- |
| Workspace | `workspace/initializeDefault`、`workspace/create`、`workspace/follow`、`workspace/archiveSession` |
| 新建会话 | `session/create`（可指定目录、工作区、agent preset） |
| 会话列表、搜索 | `session/list`、`session/search` |
| 历史与流式跟随 | `session/page`（master 中已弃用，改为 `session/events`）、`session/follow` |
| 会话状态与投影 | `session/control`、`session/projections`（`inbox`、`permissions`、`userQuestions` 等） |
| 发送消息 | `session/prompt`（带 `requestId` 可幂等重试；支持图片和文件凭证） |
| 停止 | `session/cancel` |
| 排队消息 | `session/updateQueue` |
| 重命名、fork | `session/rename`、`session/fork` |
| 模型 | `session/modelCatalog`、`session/selectModel`、`session/initializeDefaultModel` |
| 权限预设 | `permissionPresets/catalog` + 会话 `permissions` 投影 |
| 审批 | `approval/request` 转发事件，回答决定 |
| 向用户提问 | user-questions 转发事件；超时后的问题走 `userQuestions` 投影 + `userQuestions/answer`，`userQuestions/attachWait` 获取剩余等待时间 |
| 斜杠命令 | `commands/list`、`commands/execute` |
| `@` 文件引用 | `fileReferences/list` |
| skill | `skills/list` |
| 子 Agent | `subagents/list`、`subagents/prompt`、`subagents/interruptByParent` |
| 目标 | `goals/get`、`goals/create`、`goals/pause`、`goals/resume`、`goals/clear` |
| 后台任务 | `job/list`、`job/follow`、`job/kill` |
| 读取工作区文件 | `workspaceFiles/list`、`stat`、`read`、`readBytes`、`changes` |
| 每轮改动 | `workspace/changes` 会话事件 + 摘要/对比接口（Remote 方法名 **【待验证】**，由 `client/ui-deliverables` 的 Host 端提供） |
| API Key | `credentials/describe`、`credentials/set`、`credentials/unset` |
| 图片附件读取 | `session/attachment` |

---

## 7. 会话事件模型

### 7.1 持久事件（核心）

来自 `packages/core/session/src/types.ts` 的 `SessionEventMap`，其他包还会扩展更多事件类型：

| 事件 | 含义 |
| --- | --- |
| `turn/start`、`turn/end`（带 `reason`） | 一轮开始/结束 |
| `step/start`、`step/end` | 一步（一次模型请求加它调用的工具） |
| `user/message` | 用户消息 |
| `assistant/message` | 助手完整消息（内含逐字流记录、Token 用量、是否被中断） |
| `assistant/attempt` | 失败、重试、取消的尝试（不进入模型历史） |
| `tool/call` | 工具调用：`callId`、`name`、`arguments`（JSON 字符串） |
| `tool/result` | 工具结果：消息、错误、`meta`（文件修改类工具在这里带 `card: 'diff'` 展示数据） |
| `system/message`、`developer/message`、`request/*` | 系统提示词、请求头等，UI 一般不展示 |
| `workspace/changes` | 本轮改动摘要已生成（只带轮号） |
| 计划、目标、任务、权限、预设等扩展事件 | 由各包定义 |

### 7.2 实时流

- 逐字输出不是持久事件。follow 流在开场快照和后续帧里携带活跃尝试的紧凑流，客户端把它们变成**只存在于客户端**的 live chunk 条目，夹在持久事件之间。
- 持久的 `assistant/message` 或 `assistant/attempt` 到达后，结算对应的 live chunk；成功消息的临时条目保留到所属的 `step/end`，失败或中断的立即移除。
- 发现序号缺口或尝试的版本/下标不连续时，重新打开 follow 修复。
- 细节以 `packages/api/session-controller/README.zh.md` 中 `SessionEventStream` 的说明为准。

### 7.3 两种改动数据

| | 单次工具调用 diff（`tool/result.meta`） | 每轮汇总（`workspace/changes`） |
| --- | --- | --- |
| 覆盖范围 | 文件工具（`write`/`edit`/`str_replace_editor`，`apply_patch` **【待验证】**） | 本轮所有改动，含 shell 命令造成的改动（需要 git） |
| 内容 | 应用后的片段：`oldText`/`newText`，三行上下文，**没有行号，也没有完整的改动前文件** | 文件列表、增删行数、单文件对比片段（带三行上下文） |
| 持久性 | 写在会话日志里，长期可用 | 只在 Host 内存中；Host 重启后之前轮次的都没了（`workspace-changes` README） |
| 子 Agent | — | 子 Agent 会话不记录 |

---

## 8. 版本策略

- **支持一个版本范围**：最低版本在 M0 实测后确定；最高到当时的 dsh `latest`。`CHANGELOG.md` 写明每个插件版本支持的 dsh 范围。
- **启动检查**：执行 `dsh --version`。低于最低版本时提示升级，不启动；高于已测试的最高版本时照常启动，并在状态栏提示。
- **宽松解析**：入站数据用 zod 校验必需字段，未知字段忽略，未知事件跳过，单条数据解析失败只影响这一条，并写调试日志。
- **能力探测**：调用返回"方法不存在"（404 / `-32601`）时，记录到 `capabilities`，界面隐藏对应功能，不报错。
- **多版本测试**：CI 定时用最低支持版本、`latest`、`alpha` 跑集成测试；`alpha` 失败只提 issue，用来提前发现破坏性变更。
- **跟进变化**：关注 dsh 的 release notes 和仓库中 `.agents/notes/` 下的决策记录；参考项目的适配报告也是有用的信号。

---

## 9. M0 技术验证清单

M0 的目标是确认主方案在当前 dsh 版本上的细节。任何一项走不通，都要更新 DESIGN.md。

- [ ] 启动 `dsh web --no-open --port …`，从 stdout 解析 URL 和令牌；确认 `--port 0` 是否可用
- [ ] `/connect?token=…&interactions=answer` 拿到 Cookie，`ws` 连上 `/api/remote.mux`，收到 `$events` ready
- [ ] 抓取 mux 的帧格式和 unary 的请求/响应信封，写成 zod schema
- [ ] `session/list`、`session/create`、`session/prompt`，在 follow 流中收到 live chunk 和持久事件
- [ ] `session/cancel` 停止进行中的轮次
- [ ] 当前版本用的是 `session/page` 还是 `session/events`；旧版本是否兼容
- [ ] 触发一次 `approval/request`，确认数据结构（含工具参数、可选项），在插件侧回答
- [ ] 触发一次 `ask_user_question`（含超时后延迟回答）
- [ ] 文件工具的 `tool/result.meta` 中 `card: 'diff'` 的结构；`apply_patch` 是否也有
- [ ] `workspace/changes` 摘要和单文件对比对应的 Remote 方法
- [ ] `permissionPresets/catalog` 读取和当前会话预设切换
- [ ] 用临时 `DSH_HOME` + 本地假模型服务跑通一轮带工具调用的对话（确认如何把模型提供方指向本地地址）
- [ ] 多个 VS Code 窗口各启动一个 `web` profile 的 Host 时是否冲突；与用户手动运行的 `dsh web` 是否冲突
- [ ] 确定支持的最低 dsh 版本

**备选方案**：如果自写客户端在某个环节成本过高（例如 follow 流），评估在一个 Node ≥ 24 的独立子进程里加载 dsh 官方客户端库（与运行时同版本，从 dsh 安装目录加载），插件通过 stdio 和它通信。

---

## 10. 参考资料

**dsh 仓库**（基线提交 `8bd0733`）：

| 主题 | 路径 |
| --- | --- |
| 项目说明 | `README.zh.md` |
| 架构（profile、事件、轮次流程） | `docs/architecture.zh.md` |
| CLI 帮助 | `docs/cli-help.zh.md` |
| 包分组地图 | `packages/README.zh.md` |
| Web 应用组合包（启动 URL、就绪信号） | `packages/bundle/web-app/README.zh.md` |
| 连接与认证 | `packages/client/connection/README.zh.md` |
| API 网关 | `docs/api-gateway.zh.md`、`packages/api/README.zh.md` |
| Node API 调用方示例 | `packages/api/gateway/tests/authenticated-node.client.spec.ts` |
| 会话控制器（follow 流） | `packages/api/session-controller/README.zh.md` |
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
