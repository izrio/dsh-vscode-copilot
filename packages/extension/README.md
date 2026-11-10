# DSH Copilot

[DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的 VS Code 前端：侧边栏对话、逐字流式回复、紧凑的工具活动行、审批与提问、用 VS Code Diff 查看每次改动。

Agent 能力（读写文件、执行命令、沙箱与审批、会话、模型）全部由 dsh 提供，插件只负责启动和连接 dsh、显示界面，并补上 VS Code 的集成。会话保存在 dsh 里，和 dsh Web UI、DeepSeek Desktop 共用。

[English](#english) below.

## 准备

1. **安装 dsh**（支持 `0.2.1-rc.5` 及以上，已测试到 `0.2.2-alpha.3`），任选一种：
   - 安装 [DeepSeek Desktop](https://www.deepseek.com/en/download/)，在它的菜单「管理 dsh 命令…」中安装 `dsh` 命令（自带运行时）；
   - 或执行 `npm install -g @deepseek-ai/dsh`（需要 Node ≥ 24.9）。

   插件在 `PATH` 里查找 `dsh`；也可以在设置 `dsh.runtime.path` 中指定路径。
2. **配置 DeepSeek API Key**：第一次打开对话时，如果还没有配置，空白页会提示「配置 API Key」。Key 用 VS Code 的密码输入框输入，保存到 dsh 的凭据存储（与 dsh Web UI、桌面版共用，不会写进工作区）。之后也可以在「更多 → 配置 API Key」或命令「DSH: 配置 API Key」修改。
3. **打开文件夹并信任工作区**：dsh 以文件夹作为会话和沙箱的范围，会在里面读写文件、执行命令。没有打开文件夹或工作区未受信任时不会启动 dsh，视图里会给出「打开文件夹」或「管理信任」的入口。

## 使用

- **打开对话**：右侧的辅助侧边栏（Secondary Side Bar）里的 DSH 视图，或命令「DSH: 打开对话」。Enter 发送，Shift+Enter 换行；dsh 回复时继续发送的消息会排队，可以编辑、删除或插队。
- **上下文**：输入框上方显示当前编辑器——有选区时附带选中的代码和行号，否则只附带文件路径（dsh 需要时自己读）。点一下标签这条消息就不附带；默认行为由设置 `dsh.context.includeActiveEditor` 控制。
- **`@` 引用文件**：输入 `@` 选择文件或目录。
- **`/` 命令**：`/explain`、`/fix`（附带错误和警告）、`/test`、`/new`，以及 dsh 自己的命令（`/compact`、`/plan`、`/goal` 等）。
- **编辑器右键「DSH」**：解释、修复、写测试、添加到对话。
- **改动**：修改文件的那一行显示增删行数，点击在 Diff 编辑器里查看；每轮结束有改动汇总。
- **回复**：回复里指向本地文件的链接点击后在编辑器里打开；回复可以复制，代码块可以「插入到光标处」。
- **历史消息**：输入框为空时按 ↑ / ↓ 取回发送过的消息。
- **审批**：dsh 要越过工作区沙箱时会请你确认；要修改的文件在编辑器里有未保存内容时，需要先保存。
- **权限**：输入框工具条可以切换只读 / 工作区可写 / 完全访问（完全访问前会再确认一次）。
- **计划模式**：`/plan` 后 dsh 先出计划，审阅卡片里可以批准或继续完善。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `dsh.runtime.path` | 空 | dsh 可执行文件路径；为空时在 `PATH` 中查找。远程开发（Remote-SSH、code-server）时写在远端的设置里 |
| `dsh.runtime.profile` | `web` | 启动 dsh 用的 profile，默认与你自己运行的 `dsh web` 共用设置 |
| `dsh.context.includeActiveEditor` | `true` | 发送时默认附带当前编辑器 |
| `dsh.ui.language` | `auto` | 界面语言：跟随 VS Code（中文时用中文，其他用英文），或固定 `zh` / `en` |

## 常见问题

- **「找不到 dsh」**：确认终端里 `dsh --version` 能运行；VS Code 从图形界面启动时可能读不到 shell 里设置的 `PATH`，这时在 `dsh.runtime.path` 里写完整路径。
- **「dsh 版本过低」**：升级 DeepSeek Desktop，或 `npm install -g @deepseek-ai/dsh@latest`。
- **启动失败**：「更多 → 查看日志」看插件日志；dsh 自己的输出在输出面板的「DSH Runtime」里（令牌和 Key 已脱敏）。
- **会话在另一个窗口使用中**：同一个会话同时只能在一处发送消息，在那边继续或新建对话即可。

## 隐私

插件本身不发网络请求：模型请求都由 dsh 发出。dsh 只监听 `127.0.0.1`，启动令牌只保存在内存里。随消息附带的上下文是你在输入框上方看到的那些标签，可以逐条关闭。

---

## English

A VS Code front end for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): a sidebar chat with streaming replies, compact tool rows, approvals and questions, and VS Code diffs for every change. dsh does all the agent work (files, commands, sandbox, approvals, sessions, models); the extension starts and connects to dsh, renders the conversation and adds editor integration. Sessions live in dsh and are shared with the dsh Web UI and DeepSeek Desktop.

**Setup**

1. Install dsh `0.2.1-rc.5` or later: install [DeepSeek Desktop](https://www.deepseek.com/en/download/) and choose "Manage dsh command…" from its menu, or run `npm install -g @deepseek-ai/dsh` (Node ≥ 24.9). The extension looks for `dsh` on `PATH`, or set `dsh.runtime.path`.
2. Set your DeepSeek API key when the chat asks for it (or run "DSH: Set API Key"). The key goes into dsh's credential store through VS Code's password input and is never written to the workspace.
3. Open a folder and trust the workspace: dsh does not start without a folder or in an untrusted workspace (the view offers "Open Folder" / "Manage trust").

**Using it**: open the DSH view from the secondary side bar or run "DSH: Open Chat". The active editor's selection (or file path) is attached by default and can be left out per message. Type `@` to reference files and `/` for commands (`/explain`, `/fix`, `/test`, `/new`, plus dsh's own `/compact`, `/plan`, `/goal`, …). Right-click in the editor for "DSH → Explain / Fix / Write Tests / Add to Chat". Click an edited file to open its diff; links to local files in replies open in the editor; copy a reply or insert a code block at the cursor; press ↑/↓ in an empty composer for earlier messages. Approvals waiting while the view is hidden show as a badge. The UI language follows VS Code; set `dsh.ui.language` to override it.
