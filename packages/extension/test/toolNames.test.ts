import { describe, expect, it } from 'vitest';
import { canonicalTool } from '../src/vm/toolNames.ts';

describe('工具名归一', () => {
  it('内置工具名不变', () => {
    for (const name of ['bash', 'read', 'grep', 'glob', 'edit', 'write', 'todo_write']) expect(canonicalTool(name)).toBe(name);
  });

  it('去掉前缀后认出常见工具', () => {
    expect(canonicalTool('ops_grep')).toBe('grep');
    expect(canonicalTool('ops_bash')).toBe('bash');
    expect(canonicalTool('ops_read_files')).toBe('read');
    expect(canonicalTool('mcp__filesystem__read_file')).toBe('read');
    expect(canonicalTool('acme.list_dir')).toBe('ls');
    expect(canonicalTool('OPS_Write_File')).toBe('write');
  });

  it('别名', () => {
    expect(canonicalTool('run_terminal_cmd')).toBe('bash');
    expect(canonicalTool('str_replace_editor')).toBe('edit');
    expect(canonicalTool('search_files')).toBe('grep');
  });

  it('不认识的工具原样返回', () => {
    expect(canonicalTool('web_fetch')).toBe('web_fetch');
    expect(canonicalTool('compress')).toBe('compress');
    expect(canonicalTool('ops_deploy')).toBe('ops_deploy');
  });
});
