# DSH Copilot for VS Code

[DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的 VS Code 前端，交互参考 Codex：侧边栏对话、逐字流式回复、紧凑的工具活动行、审批与提问、用 VS Code Diff 查看每次改动。

Agent 能力（读写文件、执行命令、沙箱与审批、会话、模型）全部由 dsh 提供。插件只负责启动和连接 dsh，把 dsh 的会话数据转换成界面，并补上 VS Code 集成。

> 当前阶段：**方案设计**，尚未开始编码。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | 整体方案：对接方式、界面设计原则、架构、模块、运行时管理、安全、工程结构、里程碑 |
| [docs/DSH-INTEGRATION.md](./docs/DSH-INTEGRATION.md) | dsh 调研结果、参考项目分析、启动与认证、Remote 方法、会话事件、版本策略、M0 验证清单 |

## 工作方式

```
VS Code 插件（Codex 风格 UI）
    │  HTTP /api + WebSocket /api/remote.mux
    ▼
dsh Host 子进程（dsh web --no-open --port …）
    │  Agent 循环 · 工具 · 沙箱 · 审批 · 会话持久化
    ▼
模型 API（DeepSeek 等）
```

推荐通过 [DeepSeek Desktop](https://www.deepseek.com/en/download/) 安装 `dsh` 命令（自带运行时），也可以 `npm install -g @deepseek-ai/dsh`（需要 Node ≥ 24.9）。

## 与参考项目的关系

社区项目 [HarcoChen/dsh-vsc-integration](https://github.com/HarcoChen/dsh-vsc-integration) 已经验证了这条对接路线。本项目借鉴它的技术做法（运行时发现、令牌处理、从会话日志还原 Diff、未保存保护等），**重新设计对话界面**，并把首版范围收窄到核心体验。详见 [DSH-INTEGRATION.md 第 4 节](./docs/DSH-INTEGRATION.md#4-参考项目分析)和 [DESIGN.md 3.1](./docs/DESIGN.md#31-界面设计原则)。

## 开发计划

| 里程碑 | 内容 |
| --- | --- |
| M0 | 技术验证 + 脚手架：协议客户端骨架，跑通启动、连接、流式、停止；本地假模型 |
| M1 | 运行时管理 + 基础对话界面 |
| M2 | 工具活动行、审批与提问、Diff、未保存保护 |
| M3 | VS Code 上下文：选区、`@文件`、右键菜单、斜杠命令 |
| M4 | 排队消息、计划审阅、状态条、引导与性能 |
| M5 | 测试、多版本兼容 CI、发布 |

详见 [DESIGN.md 第 12 节](./docs/DESIGN.md#12-里程碑与任务拆解)。待你确认的事项见 [第 14 节](./docs/DESIGN.md#14-待确认事项)。
