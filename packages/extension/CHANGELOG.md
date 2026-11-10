# 更新记录 / Changelog

## 未发布 / Unreleased

### 修复 / Fixes

- 消息没发出去（创建会话失败、未连接、`/fix` 没有上下文）时，文字放回输入框，不再丢失。
  Text you sent comes back to the composer when nothing could be sent (session creation failed, not connected, `/fix` without context).
- 发送失败的消息在 dsh 重连后仍然显示，可以重试。
  Failed messages survive a reconnect and can still be retried.
- 英文界面下，审批原因和通信错误也显示英文。
  Approval reasons and connection errors follow the UI language.
- 本轮改动汇总遇到临时网络错误时重试，不再直接退回按文件工具汇总。
  Turn change summaries are retried after transient errors.
- 同一版本线（例如 0.2.x）里更新的 dsh 不再提示"版本较新"；提示可以关掉。
  No "newer than tested" notice within the same dsh release line; the notice can be dismissed.
- 流式回复结束时不再重新挂载，展开的推理过程保持展开。
  A finished reply updates in place; expanded reasoning stays expanded.
- Windows：dsh 安装在带空格的路径（`.cmd`）时也能启动。
  Windows: dsh installed under a path with spaces (`.cmd`) starts correctly.

### 改进 / Improvements

- 没有打开文件夹时不启动 dsh，提示打开文件夹；工作区文件夹增删时跟着切换。
  dsh no longer starts without a folder (it used to run in the home directory); follows workspace folder changes.
- 未受信任的工作区里可以打开视图，并提供「管理信任」入口；`dsh.runtime.*` 设置在未受信任时不读取工作区的值。
  Limited support in untrusted workspaces with a "Manage trust" action; `dsh.runtime.*` are restricted settings.
- 找不到 dsh 时提示条提供「设置路径」「安装说明」。
  "Set path" and "Install guide" actions when dsh is not found.
- 有审批或提问等待时，视图图标显示数字，状态栏提醒。
  View badge and status bar alert while approvals or questions are waiting.
- 往上翻时出现「回到最新」按钮；回复里的本地文件链接可以点击打开；回复可以复制；代码块可以插入到光标处；输入框为空时 ↑↓ 取回发送过的消息。
  "Jump to latest" button, clickable local file links, copy reply, insert code at cursor, ↑/↓ message history.
- 模型写大文件等工具参数时显示「准备中」；命令输出去掉终端颜色，过长时保留开头和结尾。
  "Preparing" row while tool arguments stream; ANSI codes stripped, long output keeps its tail.
- 更多语言的代码高亮（Kotlin、C/C++、C#、PHP、Ruby、Swift 等）。
  More highlighted languages (Kotlin, C/C++, C#, PHP, Ruby, Swift, …).
- 窄侧边栏下工具条不再重叠；菜单支持方向键，关闭后焦点回到按钮；审批卡片出现时获得焦点；读屏不再逐字播报流式输出。
  Narrow-sidebar layout fixes, keyboard menus, focus handling and quieter screen-reader output.

## 0.1.0

第一个可用版本。支持 dsh `0.2.1-rc.5` 及以上（已测试到 `0.2.2-alpha.3`）。

First usable release. Requires dsh `0.2.1-rc.5` or later (tested up to `0.2.2-alpha.3`).

### 对话 / Chat

- 侧边栏对话：逐字流式回复、Markdown 和代码高亮、推理过程折叠、停止生成；新建、切换、重命名、按标题搜索会话；加载更早的历史。
  Sidebar chat with streaming replies, Markdown and syntax highlighting, collapsible reasoning and stop; create, switch, rename and search sessions; load earlier history.
- dsh 的队列：回复时继续发送的消息排队，可以编辑、删除、插队；停止后可以「现在发送」。
  Queued messages from dsh's inbox: edit, delete, steer, and send now after a stop.
- 待办和目标状态条、计划模式标记。
  To-do and goal strip, plan-mode badge.

### 工具与改动 / Tools and changes

- 按工具类型显示：连续的读文件和搜索合并成一行，命令显示输出，文件修改显示增删行数。
  Tool rows by type: consecutive reads and searches merge into one row, commands show their output, edits show line counts.
- 用 VS Code 的 Diff 编辑器查看每次修改和每轮改动；dsh 重启后历史 Diff 仍能打开。
  Diffs for every edit and every turn in the VS Code diff editor, still available after dsh restarts.
- 审批卡片（预览将要写入的内容、未保存文件保护）、提问卡片、计划审阅卡片；权限预设切换。
  Approval cards (with a preview of proposed edits and an unsaved-file guard), question cards, plan review; permission presets.

### 编辑器集成 / Editor integration

- 自动附带当前选区或文件（可逐条关闭）、`@` 引用文件、`/` 斜杠命令（插件模板和 dsh 原生命令）、编辑器右键「DSH」菜单。
  Attach the current selection or file (per-message opt-out), `@` file references, `/` commands (templates and dsh's own), editor context menu.
- 多根工作区选择文件夹。
  Folder selection for multi-root workspaces.

### 界面细节 / UI details

- 按钮、菜单项、链接配上图标；点击后要等 dsh 回应的按钮显示加载中。
  Icons on buttons, menu items and links; buttons that wait for dsh show a spinner after you click.
- 上下文用量改成环形进度，随用量变色，悬停显示 token 数。
  Context usage as a ring that changes color with usage; hover for token counts.
- 加载状态：启动、打开会话（骨架屏）、会话列表、模型列表、`@` 搜索、发送中、加载更早的消息、断线重连。
  Loading states for startup, opening a session (skeleton), the session list, models, `@` search, sending, earlier history and reconnecting.
- 空状态加上示例任务；用户消息悬停可以复制、编辑后重发。
  Suggested tasks on the empty state; copy and edit-and-resend on sent messages.

### 运行时 / Runtime

- 自动查找、启动和监控 dsh，意外退出后自动重启并恢复对话；首次使用时引导配置 API Key。
  Finds, starts and supervises dsh, restarts it after a crash and restores the chat; guides you through setting the API key.
- 中英文界面，跟随 VS Code 的显示语言（设置 `dsh.ui.language` 可以覆盖）。
  Chinese and English UI following the VS Code display language (`dsh.ui.language` overrides it).
