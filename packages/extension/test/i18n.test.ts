import { afterEach, describe, expect, it } from 'vitest';
import { resolveLocale, setLocale, t } from '../src/i18n.ts';
import { pluginCommands, templatePrompt } from '../src/vm/context.ts';
import { project } from '../src/dsh/view/projector.ts';

const CJK = /[　-〿一-鿿＀-￯]/u;

describe('界面语言', () => {
  afterEach(() => setLocale('zh'));

  it('跟随 VS Code 的显示语言，设置可以覆盖', () => {
    expect(resolveLocale('zh-cn')).toBe('zh');
    expect(resolveLocale('zh-TW')).toBe('zh');
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('ja')).toBe('en');
    expect(resolveLocale('en', 'zh')).toBe('zh');
    expect(resolveLocale('zh-cn', 'en')).toBe('en');
  });

  it('英文界面：对话流里的提示、活动行、模板命令都是英文', () => {
    setLocale('en');
    const event = (seq: number, type: string, data: unknown) => ({ type, seq, time: seq, data });
    const items = project({
      events: [
        event(1, 'tool/call', { callId: 'r1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
        event(2, 'tool/call', { callId: 'g1', name: 'grep', arguments: JSON.stringify({ pattern: 'x' }) }),
        event(3, 'turn/end', { reason: { kind: 'aborted' } }),
      ],
      pending: [],
    }).items;
    expect(items).toMatchObject([{ kind: 'explore', summary: 'read 1 file(s), searched 1 time(s)' }, { kind: 'notice', text: 'Stopped' }]);
    expect(templatePrompt('fix', '')).toMatch(/^Find the problems/u);
    expect(pluginCommands().map((c) => c.description).join(' ')).not.toMatch(CJK);
    expect(t('send.failed', 'boom')).toBe('Failed to send: boom');
  });

  it('英文文案里没有残留的中文（键是否齐全由类型检查保证）', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/i18n.ts', import.meta.url), 'utf8');
    const enBlock = source.slice(source.indexOf('const en:'), source.indexOf('const catalogs'));
    expect(enBlock.split('\n').filter((line) => CJK.test(line.replace(/\/\/.*$/u, '')))).toEqual([]);
    const ui = readFileSync(new URL('../../webview-ui/src/i18n.ts', import.meta.url), 'utf8');
    const uiEn = ui.slice(ui.indexOf('const en:'), ui.indexOf('const catalogs'));
    expect(uiEn.split('\n').filter((line) => CJK.test(line))).toEqual([]);
  });
});
