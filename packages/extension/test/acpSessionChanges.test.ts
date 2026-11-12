import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionHeader } from '@harness-deck/shared';
import { AcpController, type AcpLink } from '../src/acp/AcpController.ts';
import { AcpSessionProjection } from '../src/acp/projection.ts';
import { noWorkbench, type Workbench } from '../src/vm/workbench.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}/tools.json`, import.meta.url), 'utf8')) as { load: Record<string, unknown>[] };

describe('ACP 会话改动栏的数据', () => {
  for (const agent of ['claude', 'codebuddy']) {
    it(`${agent}：按文件归并，新建的标出来，增删行数是各次修改的合计`, () => {
      const p = new AcpSessionProjection('/w');
      for (const update of fixture(agent).load) p.apply(update);
      expect(p.fileChanges().map((f) => ({ path: f.path, created: f.created, additions: f.additions, deletions: f.deletions, diffs: f.diffs.length }))).toEqual([
        { path: '/w/hello.txt', created: true, additions: 2, deletions: 0, diffs: 1 },
        { path: '/w/notes.txt', created: false, additions: 2, deletions: 1, diffs: 1 },
      ]);
    });
  }

  it('没有 diff 内容的写入（omp 的 write）按写入的行数计，失败的修改不算', () => {
    const p = new AcpSessionProjection('/w');
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'w1', name: 'write', kind: 'edit', status: 'completed', rawInput: { path: 'a.md', content: 'x\ny\n' }, locations: [{ path: '/w/a.md' }] });
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'e1', name: 'edit', kind: 'edit', status: 'failed', content: [{ type: 'diff', path: '/w/b.md', oldText: 'a', newText: 'b' }] });
    expect(p.fileChanges()).toMatchObject([{ path: '/w/a.md', additions: 2, deletions: 0, diffs: [] }]);
  });
});

describe('打开一个文件在本会话的累计改动', () => {
  it('从当前内容倒着撤回两次修改，左边是会话开始前的内容，右边是真实文件', async () => {
    const opened: unknown[] = [];
    const workbench: Workbench = {
      ...noWorkbench,
      readFile: async () => 'one\nTWO\nthree\nfour\n',
      openDiff: async (request) => void opened.push(request),
    };
    const link: AcpLink = { request: async <T,>() => ({ sessionId: 's1' }) as T, notify: () => undefined };
    const c = new AcpController({
      workspacePath: '/w',
      workbench,
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      renderDelayMs: 0,
    });
    c.setLink(link, { authMethods: [] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const edit = (id: string, oldText: string, newText: string) =>
      c.onSessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: id, name: 'Edit', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/w/a.txt', oldText, newText }] } });
    edit('e1', 'two', 'TWO');
    edit('e2', 'three\n', 'three\nfour\n');
    const header = (c as unknown as { compute(): { session: SessionHeader } }).compute().session;
    expect(header.changes).toMatchObject({ files: [{ path: 'a.txt', ref: { kind: 'session', path: '/w/a.txt' }, additions: 2, deletions: 1 }], additions: 2, deletions: 1 });
    await c.handle({ type: 'openDiff', payload: { ref: { kind: 'session', path: '/w/a.txt' } } });
    expect(opened).toEqual([{ kind: 'contents', path: '/w/a.txt', before: 'one\ntwo\nthree\n', created: false, scope: 'session' }]);
    c.dispose();
  });
});
