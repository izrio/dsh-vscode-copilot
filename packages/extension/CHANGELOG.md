# 更新记录 / Changelog

## 0.3.2

**ACP 底层（Claude、oh-my-pi、CodeBuddy）也有多开标签和会话改动栏**；新对话沿用上次选的模型；dsh 底层改叫 DeepSeek；护眼配色、滚动到底部、skill 补全和一轮界面打磨。

**Tabs and the session changes bar on ACP backends (Claude, oh-my-pi, CodeBuddy)**; new chats keep the last chosen model; the dsh backend is shown as DeepSeek; soft colors, scroll to bottom, skill completion and a round of UI polish.

- ACP 底层（Claude、oh-my-pi、CodeBuddy 等）也支持多开标签：新对话开在新标签里，从会话列表打开已在标签里的会话时切过去，后台标签显示运行中和等待审批；打开的标签按底层记住。
  Tabs for ACP backends (Claude, oh-my-pi, CodeBuddy…): a new chat opens a new tab, opening a session that already has a tab switches to it, background tabs show running and waiting-for-approval, and open tabs are remembered per backend.
- 界面细节打磨：流式回复的光标跟在文字末尾（不再单独占一行）；消息下面的「复制 / 编辑后重发」和排队消息的「编辑 / 插队 / 删除 / 现在发送」改成悬停变亮的灰色小图标（窄宽度下不再一个字一行地折行）；未保存文件的提示改成卡片；配置 API Key 页和首页风格一致；输入框的占位文字只占一行；上下文用量过半才显示百分比，平时只显示圆环；改动栏和输入框之间留出间距。
  UI polish: the streaming cursor follows the text instead of taking its own line; message and queue actions are compact gray icons that light up on hover (no more one-character-per-line wrapping when narrow); the unsaved-files notice is a card; the API key page matches the home; the placeholder stays on one line; the context ring shows a percentage only past 50%; the changes bar has a gap above the composer.
- ACP 底层（Claude、oh-my-pi、CodeBuddy 等）也有会话改动栏：输入框上方列出本会话用文件工具改过的文件和增删行数，点文件打开累计 Diff（从当前内容倒着撤回本会话的修改，还原出会话开始前的内容）。命令造成的改动 ACP 代理不上报，不在其中。
  The session changes bar now works on ACP backends (Claude, oh-my-pi, CodeBuddy…): files edited by file tools in this session with line counts; clicking one opens the cumulative diff, rebuilt by undoing this session's edits from the current file. Changes made by commands are not reported by ACP agents and are not included.
- 修复：DeepSeek（dsh）底层输入 `/` 看不到 skill。dsh 的 skill 不在命令列表里，现在另外读取 skill 目录（工作区 `.dsh/skills`、`.agents/skills` 和全局的），补全里带「skill」标签；每次打开会话都重新读取，新装的 skill 也能出现。
  Fixed: skills did not show up after typing `/` on the DeepSeek (dsh) backend. dsh lists skills separately from commands; they are now read on every session open and shown with a "skill" tag.
- 斜杠补全更好找：不区分大小写，名字中间的一段也能搜到（输入 `review` 能找到 `code-review`），名字可以带冒号（`/engineering:code-review`）。
  Slash completion is easier to search: case-insensitive, matches inside names (`review` finds `code-review`), and names may contain colons (`/engineering:code-review`).
- 护眼配色（默认）：对话里的文字不再用接近纯白的主题前景色，正文、标题、次要信息分层柔和，长时间看不累；「字体与字号」里可以关掉改用主题原色（设置 `harnessDeck.ui.palette`），高对比度主题始终用原色。
  Soft colors (default): chat text no longer uses the near-white theme foreground; body, headings and secondary text are toned down for long reading. Turn it off under Font & Size (setting `harnessDeck.ui.palette`); high-contrast themes always use theme colors.
- 「滚动到底部」按钮：往上翻看历史时出现在右下角，翻上去时有新内容会带提示点，点一下回到底部并继续跟随新内容。
  Scroll-to-bottom button: appears while you read earlier messages, shows a dot when new content arrives, and returns to following the conversation.
- 内置底层 dsh 在界面上改叫 **DeepSeek**（命令、网页等指 dsh 程序本身的地方仍写 dsh）；原来的会话和设置不受影响。
  The built-in dsh backend is now shown as **DeepSeek** (places that mean the dsh program itself still say dsh); sessions and settings are unchanged.
- 旧版扩展 DSH Copilot 还装着时（编辑器右键菜单里会多一个「DSH」），启动时提示并可以一键卸载。
  If the old DSH Copilot extension is still installed (it adds the "DSH" editor context menu), Harness Deck offers to uninstall it.
- ACP 底层的新对话沿用上次选的模型和思考等级（按底层记住）。之前 Claude 等代理的模型是按会话设置的，新开的会话总是回到默认模型，和刚才选的不一样；已有的会话仍保持自己的模型。
  New chats on ACP backends use the model and thought level you picked last (remembered per backend). Before, agents such as Claude set the model per session, so a new chat went back to the default model; existing sessions keep their own.
- 修复：回复后面开始调用工具时，前面那段文字末尾一直留着蓝色光标。
  Fixed: the blue cursor stayed after a reply's text once tool calls started.
- 修复：模型网关每次回复都用同一个消息 id 时，工具调用之后的文字被拼到前面的段落里，看起来像中间没有文字；现在按时间顺序另起一段。
  Fixed: with model gateways that reuse one message id, text after tool calls was merged into an earlier paragraph and looked missing; it now starts a new paragraph in order.
- 新设置 `harnessDeck.backendTrace`：把和 ACP 底层收发的消息原文写到「Harness Deck: Backend」输出面板，用来排查代理实际发了什么。
  New setting `harnessDeck.backendTrace`: writes the raw ACP messages to the "Harness Deck: Backend" output channel for troubleshooting.

## 0.3.1

**新的内置底层 Claude**；ACP 代理需要登录时的提示；内部包名改为 `@harness-deck/*`，README 重写。

**New built-in backend: Claude**; clearer sign-in handling for ACP agents; internal packages renamed to `@harness-deck/*` and a rewritten README.

- 新的内置底层 **Claude**：通过 Claude Code 的官方 ACP 适配器（`npm install -g @agentclientprotocol/claude-agent-acp`）接入，登录和设置与 Claude Code 共用；选择卡片、首页和菜单里显示 Claude 的图标。
  New built-in backend **Claude**, through Claude Code's official ACP adapter (`npm install -g @agentclientprotocol/claude-agent-acp`); sign-in and settings are shared with Claude Code. The chooser, home and menu show the Claude icon.
- ACP 底层发消息时才发现需要登录（Claude 没登录或登录过期）：代理有登录方式时先登录再重发这一轮，没有时在对话里说明怎么登录，而不是只显示「Authentication required」。
  When an ACP backend reports that sign-in is needed while sending (Claude signed out or expired), the panel signs in and resends if the agent offers a sign-in method, or explains how to sign in instead of showing "Authentication required".
- 工作区里的内部包改名为 `@harness-deck/shared`、`@harness-deck/webview-ui`；仓库 README 按 Harness Deck 重写（底层对照表、新截图、架构图、各底层的测试方法）。
  Workspace packages renamed to `@harness-deck/shared` and `@harness-deck/webview-ui`; the repository README is rewritten for Harness Deck (backend table, new screenshots, architecture, tests for every backend).

## 0.3.0

**改名为 Harness Deck，支持多个底层：dsh、oh-my-pi、CodeBuddy，以及任何 ACP 代理。** 第一次打开面板时选底层；新首页和新标志；子代理显示。dsh 底层支持 `0.2.1-rc.5` 及以上。

**Renamed to Harness Deck, with switchable backends: dsh, oh-my-pi, CodeBuddy and any ACP agent.** Pick a backend on first open; new home and logo; subagents shown. The dsh backend requires dsh `0.2.1-rc.5` or later.

- 底层可以切换：dsh，以及内置的 ACP（Agent Client Protocol）代理 oh-my-pi（`omp acp`）和 CodeBuddy（`codebuddy --acp`），也可以在设置 `harnessDeck.backends` 里加别的 ACP 代理。「…」→「底层」或命令「切换底层」里切换；每个底层的会话分开保存。
  Switchable backends: dsh, the built-in ACP (Agent Client Protocol) agents oh-my-pi (`omp acp`) and CodeBuddy (`codebuddy --acp`), and any ACP agent added in `harnessDeck.backends`. Switch from "…" → Backend or the Switch Backend command; sessions are kept per backend.
- 第一次打开面板时显示底层选择卡片：每个底层的说明、本机是否已安装，没装的给出可以复制的安装命令；选好或「稍后再说」后不再出现。首页重新设计：渐变标识、当前底层和工作区标签（点击切换底层）、带说明的示例任务、输入提示。选择卡片、首页和菜单里的底层显示官方图标（DeepSeek、oh-my-pi、CodeBuddy）。插件有了自己的标志：两张卡片组成 H，中间的挽带和节点把它们连起来（插件图标、侧边栏图标、首页）。
  On first open the panel asks which backend to use, with a description of each, whether it is installed on this machine and a copyable install command otherwise; it does not ask again once chosen or skipped. Redesigned home: gradient logo, current backend and workspace chips (click to switch backend), example tasks with descriptions, input tips. Backends show their official icons (DeepSeek, oh-my-pi, CodeBuddy) in the chooser, home and menu. New Harness Deck logo: two cards forming an H, joined by a strap and a node (extension icon, sidebar icon, home).
- CodeBuddy：需要登录时选择登录方式（iOA、Google/GitHub、微信、企业域名），在浏览器里完成；也可以用 `CODEBUDDY_API_KEY`。待办（TaskCreate / TaskUpdate）进入输入框上方的状态条，命令输出去掉包装格式，Edit 的 Diff 显示整个文件。CodeBuddy 的一个进程只给一个会话推送回复，切回别的会话发消息时插件会重启 CodeBuddy 并重新加载那个会话（约 2 秒）。
  CodeBuddy: pick a sign-in method (iOA, Google/GitHub, WeChat, enterprise domain) and finish in the browser, or use `CODEBUDDY_API_KEY`. To-dos (TaskCreate / TaskUpdate) go to the status strip, command output is unwrapped, Edit diffs show the whole file. A CodeBuddy process streams to one session only, so sending in another session restarts CodeBuddy and reloads that session (about 2 s).
- ACP 底层支持流式回复和推理、工具行（读文件和搜索合并、命令输出、修改的增删行数和 Diff）、审批、待办、用量、斜杠命令、模型和思考等级、模式（计划模式）、会话列表和重新打开、停止、图片；用真实的 oh-my-pi 和 CodeBuddy 做端到端测试，并每天在 CI 里对它们的固定版本和最新版本各跑一次。
  ACP backends cover streaming replies and reasoning, tool rows (grouped reads/searches, command output, edit line counts and diffs), approvals, to-dos, usage, slash commands, model and thought level, modes (plan), session list and reload, stop and images; tested end to end against real oh-my-pi and CodeBuddy, nightly in CI.
- 插件改名为 Harness Deck：命令、视图和设置从 `dsh.*` 改为 `harnessDeck.*`（原来的设置第一次启动时自动迁移），安装包改名为 `harness-deck-<版本>.vsix`。这是新的扩展 id，升级后可以卸载 DSH Copilot。
  Renamed to Harness Deck: commands, views and settings moved from `dsh.*` to `harnessDeck.*` (old settings are migrated on first start); the package is `harness-deck-<version>.vsix`. It is a new extension id, so DSH Copilot can be uninstalled afterwards.
- 子代理：dsh 派出的子代理显示成一张卡片（任务描述、状态、用时，点开看任务和回答），可以打开子代理自己的对话（只读）。
  Subagents show as a card (task, state, elapsed time; expand for the task and answer) and their conversation can be opened read-only.

## 0.2.3

行内代码不再是醒目的橙色；系统减少动画时加载转圈照常播放。支持 dsh `0.2.1-rc.5` 及以上。

Inline code no longer shows in orange; loading indicators keep animating under reduced motion. Requires dsh `0.2.1-rc.5` or later.

- 加载中的转圈、运行中的圆点和「思考中」在系统「减少动画」时也照常播放（之前全部停住；Windows 关了动画效果或在远程桌面里就是这种情况）。只停掉骨架屏的流光和光标闪烁。
  Spinners, running dots and the "thinking" pulse keep animating when the OS asks for reduced motion (Windows with animation effects off, Remote Desktop); only the skeleton shimmer and cursor blink stop.

- 行内代码不再是醒目的橙色：改用正文颜色，配淡淡的中性底色和描边（之前没设颜色，沿用了 VS Code 默认样式里主题的 textPreformat 色，很多深色主题是橙色）。跨行时每段都有完整描边。
  Inline code no longer shows in the theme's orange preformatted color: it uses the text color on a soft neutral background with a faint outline, and wraps cleanly.

## 0.2.2

粘贴图片、面板内调整字体与字号，修复从插件打开 dsh 网页时登录失败。支持 dsh `0.2.1-rc.5` 及以上。

Paste images, adjust font and size inside the panel, and fix logging in when opening dsh in the browser. Requires dsh `0.2.1-rc.5` or later.

- 「…」→「字体与字号」改为面板里直接调整：字号加减、界面字体、代码字体、恢复默认，立即生效并写入设置 `dsh.ui.*`（之前是跳到 VS Code 设置页，可能找不到对应设置）。
  "…" → "Font and size" now opens an in-panel editor (size stepper, UI and code fonts, reset) that applies immediately and writes `dsh.ui.*`, instead of jumping to the Settings page.

- 支持图片：在输入框里粘贴截图或复制的图片（也可以按住 Shift 拖进来），显示成缩略图，可以移除，随消息发给 dsh，可以只发图片。消息里显示发送过的图片（从 dsh 读取），点击放大。图片被 dsh 拒绝时提示原因。
  Images: paste a screenshot or copied image into the input box (or Shift-drag one in); it shows as a removable thumbnail and is sent with the message, text optional. Sent images appear in the conversation (read back from dsh) and open larger on click.

- 修复「在浏览器中打开 dsh」认证失败：VS Code 的 Uri 会把地址里的 `?token=` 编码成 `?token%3D`，dsh 认不出令牌，返回 401。现在打开的地址和 `dsh web` 打印的完全一样（远程开发时只转发端口）。回复里带参数的链接也不再被改写。
  Fix "Open dsh in browser" failing to log in: vscode.Uri encoded `?token=` as `?token%3D`, so dsh returned 401. The browser now gets exactly the URL `dsh web` prints (only the port is forwarded in remote setups). Links with query strings are no longer rewritten either.

## 0.2.1

运行状态与用时、逐题回答的提问卡片、级联的模型选择、更醒目的强调色、识别带前缀的工具，以及若干界面修正。支持 dsh `0.2.1-rc.5` 及以上。

Run status with elapsed time, step-by-step questions, a cascading model picker, a reliable accent color, prefixed tool names, and UI fixes. Requires dsh `0.2.1-rc.5` or later.

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
