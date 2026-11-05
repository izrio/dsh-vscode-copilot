# 更新记录 / Changelog

## 未发布 / Unreleased

- 识别带前缀或别名的工具：`ops_grep`、`ops_read_files`、`mcp__fs__read_file`、`run_command`、`str_replace_editor` 等按对应的内置工具渲染——连续的读文件和搜索合并成一行「已浏览」，命令显示「已运行」，修改显示文件；一次读多个文件时显示第一个文件和其余数量。
  Prefixed or aliased tools (`ops_grep`, `ops_read_files`, `mcp__fs__read_file`, `run_command`, `str_replace_editor`, …) render like the built-in ones: reads and searches merge into one row, commands show "Ran", edits show the file; multi-file reads show the first file and a count.

- 运行状态：dsh 处理时对话末尾显示正在做什么（思考 / 回复 / 运行命令 / 编辑某文件 / 调用某工具 / 等你处理）和已用时间，每秒刷新；一轮结束后显示「已完成 · 用时 …」（超过 1 秒的轮次）。用时取 dsh 记录的开始和结束时间。
  Run status: while dsh works, the end of the conversation shows what it is doing and the elapsed time, updated every second; finished turns longer than a second show "Done · took …", using dsh's own start and end times.

- 强调色改为运行时从主题里挑第一个有颜色的（主按钮 → 焦点边框 → 链接 → 进度条 → 图表蓝），并配好文字色。按钮、输入框边框和焦点、链接、进度、选中项都用它，按钮和焦点色是灰色的主题下也不会再"没有颜色"。
  The accent color is picked at runtime from the first colorful theme color (button → focus border → link → progress bar → chart blue) with a matching text color, and used for buttons, the input border and focus, links, progress and selections, so themes with gray button or focus colors still look colored.

- 提问卡片逐题回答：多个问题时一次显示一道，顶部显示「第 1 / 3 题」和可点击的进度条，单选后自动进入下一题，可以返回上一题，最后一题才提交。选项改成带单选圈 / 多选框的卡片。
  Questions are answered one at a time: a "1 of 3" counter and clickable progress steps, single-choice answers advance automatically, Back/Next, and Submit on the last question. Options show radio or checkbox marks.

- 回复结尾不再显示改动文件卡片（输入框上方的会话改动栏已经列出）；需要时用设置 `dsh.ui.showTurnChanges` 打开。
  The changed-files card at the end of each reply is hidden by default (the session changes bar lists them); turn it back on with `dsh.ui.showTurnChanges`.
- 代码块和行内代码跟随对话文字的字号（之前代码块用编辑器字号，显得偏大）。
  Code blocks and inline code follow the chat font size instead of the editor's.

- 「在浏览器中打开 dsh」：通过 VS Code 转发端口打开（远程开发时 dsh 的 127.0.0.1 在远端机器上，之前直接打开连不上）；打开后提示当前会话的标题，并可以复制链接。dsh 网页目前没有指向某个会话的地址，只能在它的会话列表里选。
  "Open dsh in browser" goes through VS Code's port forwarding (dsh's 127.0.0.1 is on the remote machine in remote development), then shows the current session's title and a "Copy link" button. dsh's web UI has no per-session URL yet.
- 待办改成卡片：进度条和计数徽标，完成项绿色勾、进行中的项高亮并标「进行中」、待做项空心圈，状态标记连成时间线。
  To-dos are a card with a progress bar and count badge; done items get a green check, the current one is highlighted, pending ones show a hollow circle.
- 模型选择：当前项带勾和强调色底色；有多个思考等级的模型改为级联——先选模型，再在第二级选思考等级（标出当前和默认等级）。
  Model picker: the current item has a check and accent background; models with several reasoning levels open a second level to pick the level.

## 0.2.0

多开会话、会话改动栏、更快的 Diff、字体设置。支持 dsh `0.2.1-rc.5` 及以上。

Tabs for multiple sessions, a session changes bar, faster diffs and font settings. Requires dsh `0.2.1-rc.5` or later.

- 多开会话：「+」在新标签里开始新对话，不再覆盖当前会话；从会话列表打开的会话也放进标签。后台标签的会话继续运行，最近的 4 个后台标签一直跟随，切回时内容立即可见；标签上显示运行中和等待审批。关闭标签不会删除会话。每个标签有自己的输入草稿。
  Multiple sessions as tabs: "+" opens a new tab instead of replacing the current session, and sessions picked from the list open in tabs. Background sessions keep running; the four most recent stay followed so switching back is instant. Tabs show running and needs-attention state; closing a tab keeps the session. Each tab keeps its own draft.
- 图标颜色：强调色改用主题的链接色（不少主题的 focusBorder 是灰色或透明，图标会没有颜色）；空状态的示例任务各有一种颜色。
  Icons use the theme's link color as accent instead of focusBorder (gray or transparent in many themes); the empty-state suggestions each get their own color.

- 会话改动栏：输入框上方列出本会话改过的文件和增删行数，可以展开、收起、隐藏；点击文件打开本会话修改前 ↔ 当前的累计 Diff。
  Session changes bar above the input box: files changed in this session with line counts, collapsible and dismissible; click a file for its cumulative diff.
- 打开 Diff 更快：本轮改动能用会话日志里的工具片段还原时直接在本地还原，不再请求 dsh；只有命令造成的改动才读取 dsh 的记录（超时缩短到 15 秒，结果缓存）。改动汇总同时最多读两个，打开长会话时不再把 dsh 堵住。点击后对应的行显示加载中，重复点击不重复请求。
  Faster diffs: turn diffs are rebuilt locally from the session log when the tool edits explain the turn, and only fall back to dsh for changes made by commands (15 s timeout, cached). Change summaries load at most two at a time. Rows show a spinner while the diff opens; repeated clicks are ignored.
- 打开较早一轮的 Diff 时，右侧是那一轮结束时的内容（之前是当前文件，常常还原失败）。
  Diffs of earlier turns now compare against the content at the end of that turn.
- 字号默认比 VS Code 工作台大 1px；新增设置 `dsh.ui.fontSize`、`dsh.ui.fontFamily`、`dsh.ui.codeFontFamily`，「…」菜单里有「字体与字号」入口。
  Default font size is 1px larger than the workbench; new settings `dsh.ui.fontSize`, `dsh.ui.fontFamily`, `dsh.ui.codeFontFamily`, reachable from "…" → "Font and size".
- 工具活动行之间的间距加大；输入框顶边可以拖动调整高度（双击恢复）。
  More spacing between tool rows; drag the top edge of the input box to resize it (double-click to reset).

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
