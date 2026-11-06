/**
 * 工具名归一：dsh 自带的工具是 `bash`、`read`、`grep` 这样的短名，但插件、MCP 或自定义预设提供的工具常带前缀
 * （`ops_grep`、`mcp__fs__read_file`）或用别的叫法（`read_files`、`run_command`、`str_replace_editor`）。
 * 归一成内置工具名后，它们和内置工具一样渲染：只读操作合并成「浏览」、命令显示「已运行」、修改显示文件。
 */

/** 别名 → 内置工具名。 */
const ALIASES: Readonly<Record<string, string>> = {
  // 命令
  bash: 'bash',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  pwsh: 'bash',
  powershell: 'bash',
  cmd: 'bash',
  terminal: 'bash',
  run_command: 'bash',
  run_shell_command: 'bash',
  run_terminal_cmd: 'bash',
  run_terminal_command: 'bash',
  execute_command: 'bash',
  exec_command: 'bash',
  exec: 'bash',
  // 修改
  edit: 'edit',
  edit_file: 'edit',
  edit_files: 'edit',
  multi_edit: 'multi_edit',
  multiedit: 'multi_edit',
  apply_patch: 'apply_patch',
  str_replace: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit',
  replace_in_file: 'edit',
  search_replace: 'edit',
  notebook_edit: 'notebook_edit',
  write: 'write',
  write_file: 'write',
  write_to_file: 'write',
  create_file: 'write',
  // 只读
  read: 'read',
  read_file: 'read',
  read_files: 'read',
  read_many_files: 'read',
  view_file: 'read',
  open_file: 'read',
  cat: 'read',
  read_image: 'read_image',
  glob: 'glob',
  find_files: 'glob',
  file_search: 'glob',
  grep: 'grep',
  rg: 'grep',
  ripgrep: 'grep',
  search: 'grep',
  search_files: 'grep',
  search_code: 'grep',
  code_search: 'grep',
  grep_search: 'grep',
  ls: 'ls',
  list: 'list',
  list_dir: 'ls',
  list_files: 'ls',
  list_directory: 'ls',
  tree: 'ls',
  // 子代理（委派任务）
  subagent: 'subagent',
  task: 'subagent',
  spawn_subagent: 'subagent',
  delegate_task: 'subagent',
  // 其他有专门界面的工具
  todo_write: 'todo_write',
  ask_user_question: 'ask_user_question',
  exit_plan_mode: 'exit_plan_mode',
};

/**
 * 归一后的工具名：先看整名，再依次去掉前缀（`_` `__` `.` `:` `/` `-` 分隔）看剩下的部分；都不认识时原样返回。
 * @example canonicalTool('ops_read_files') === 'read'；canonicalTool('mcp__fs__grep') === 'grep'
 */
export function canonicalTool(name: string): string {
  const lower = name.toLowerCase();
  const direct = ALIASES[lower];
  if (direct) return direct;
  for (const match of lower.matchAll(/[_.:/-]+/gu)) {
    const rest = lower.slice((match.index ?? 0) + match[0].length);
    const alias = ALIASES[rest];
    if (alias) return alias;
  }
  return name;
}
