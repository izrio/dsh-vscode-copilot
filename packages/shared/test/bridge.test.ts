import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from '../src/index.ts';

describe('parseWebviewMessage', () => {
  it('接受合法消息', () => {
    expect(parseWebviewMessage({ type: 'ready', payload: {} })).toEqual({ type: 'ready', payload: {} });
  });

  it('拒绝未知类型和缺少 payload 的消息', () => {
    expect(parseWebviewMessage({ type: 'runCommand', payload: { command: 'rm -rf /' } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'ready' })).toBeUndefined();
    expect(parseWebviewMessage('ready')).toBeUndefined();
  });
});
