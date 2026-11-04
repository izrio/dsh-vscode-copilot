# DSH Copilot for VS Code

[DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的 VS Code 前端，交互参考 Codex：侧边栏对话、逐字流式回复、紧凑的工具活动行、审批与提问、用 VS Code Diff 查看每次改动。

Agent 能力（读写文件、执行命令、沙箱与审批、会话、模型）全部由 dsh 提供。插件只负责启动和连接 dsh，把 dsh 的会话数据转换成界面，并补上 VS Code 集成。

> 当前阶段：**M0 已完成**（协议客户端在真实 dsh 上跑通），对话界面在 M1 开发。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | 整体方案：对接方式、界面设计原则、架构、模块、运行时管理、安全、工程结构、里程碑 |
| [docs/DSH-INTEGRATION.md](./docs/DSH-INTEGRATION.md) | dsh 调研结果、参考项目分析、启动与认证、线上格式、Remote 方法、会话事件、版本策略、M0 验证结果 |

## 工作方式

```
VS Code 插件（Codex 风格 UI）
    │  HTTP /api + WebSocket /api/remote.mux
    ▼
dsh Host 子进程（dsh --profile web --no-open --host 127.0.0.1 --port 0）
    │  Agent 循环 · 工具 · 沙箱 · 审批 · 会话持久化
    ▼
模型 API（DeepSeek 等）
```

使用前需要能在终端运行 `dsh`（支持 `0.2.1-rc.5` 及以上）：推荐安装 [DeepSeek Desktop](https://www.deepseek.com/en/download/) 并在它的菜单「管理 dsh 命令…」中安装 `dsh` 命令（自带运行时），也可以 `npm install -g @deepseek-ai/dsh`（需要 Node ≥ 24.9）。

## 开发

需要 Node ≥ 20.19 和 pnpm 10。

```bash
pnpm install
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm build
```

```bash
pnpm package
```

`pnpm package` 产出 `packages/extension/dsh-copilot-<版本>.vsix`。调试时用 VS Code 打开 `packages/extension` 并按 F5 启动扩展开发宿主（先执行一次 `pnpm build`）。

### 用真实 dsh 跑冒烟测试

冒烟测试用临时 `DSH_HOME` 和本地假模型，不需要 API Key，也不会读取你的会话：

```bash
pnpm smoke -- --dsh "$(command -v dsh)"
```

本机 Node 低于 24.9 时，可以用 `--node-bin <Node 24 的 bin 目录>` 指定 dsh 使用的 Node；加 `--record` 会重新录制 `packages/extension/test/fixtures/m0/` 下的 fixture。

### 目录结构

```
packages/
├── shared/        Host 与 Webview 共用的消息类型和校验
├── extension/     VS Code 插件（Extension Host）
│   ├── src/runtime/      定位、版本检查、启动和监控 dsh
│   ├── src/dsh/          dsh 协议客户端（唯一了解 dsh 协议的目录）
│   ├── src/webview/      侧边栏视图宿主
│   ├── scripts/          构建脚本、M0 冒烟测试
│   └── test/             单元测试、假模型、录制的 fixture
└── webview-ui/    侧边栏界面（React + Vite）
```

## 与参考项目的关系

社区项目 [HarcoChen/dsh-vsc-integration](https://github.com/HarcoChen/dsh-vsc-integration) 已经验证了这条对接路线。本项目借鉴它的技术做法（运行时发现、令牌处理、从会话日志还原 Diff、未保存保护等），**重新设计对话界面**，并把首版范围收窄到核心体验。详见 [DSH-INTEGRATION.md 第 4 节](./docs/DSH-INTEGRATION.md#4-参考项目分析)和 [DESIGN.md 3.1](./docs/DESIGN.md#31-界面设计原则)。

## 开发计划

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 技术验证 + 脚手架：协议客户端、运行时管理、假模型、冒烟测试、CI | ✅ |
| M1 | 运行时管理完善 + 基础对话界面 | |
| M2 | 工具活动行、审批与提问、Diff、未保存保护 | |
| M3 | VS Code 上下文：选区、`@文件`、右键菜单、斜杠命令 | |
| M4 | 排队消息、计划审阅、状态条、引导与性能 | |
| M5 | 测试、多版本兼容 CI、发布 | |

详见 [DESIGN.md 第 12 节](./docs/DESIGN.md#12-里程碑与任务拆解)。
