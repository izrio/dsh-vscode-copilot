# DSH Copilot for VS Code

连接 dsh 服务的 VS Code AI 编程助手插件，交互参考 Codex：侧边栏对话，AI 可以读代码、改代码、执行命令；所有改动都能预览、确认和回滚。

> 当前阶段：**方案设计**，尚未开始编码。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | 整体方案：产品形态、架构、模块设计、安全、工程结构、里程碑 |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | dsh 服务接入协议（草案）、工具定义、Mock 服务 |

## 待确认

开发前需要和 dsh 服务方确认的事项见 [DESIGN.md 第 2 节](./docs/DESIGN.md#2-关键假设与待确认事项)，其中最关键的是：

**dsh 是 Agent 服务（服务端跑 Agent 循环），还是只提供模型推理？** 这决定 Agent 循环在哪里实现。

## 开发计划

| 里程碑 | 内容 |
| --- | --- |
| M0 | 工程脚手架：pnpm workspace、空白侧边栏、Mock 服务 |
| M1 | 基础对话：连接、登录、流式输出、多会话 |
| M2 | 上下文：当前文件/选区、`@` 引用、右键菜单 |
| M3 | Agent 工具与审批：读/搜/改文件、执行命令、Diff 预览 |
| M4 | 体验与稳定性：回滚、模型选择、斜杠命令、性能 |
| M5 | 接入真实 dsh 与发布 |

详见 [DESIGN.md 第 11 节](./docs/DESIGN.md#11-里程碑与任务拆解)。
