import { beforeAll, describe, expect, it } from 'vitest';

let parseFileRef: typeof import('../src/components/Markdown.tsx').parseFileRef;

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
  ({ parseFileRef } = await import('../src/components/Markdown.tsx'));
});

describe('回复里的文件路径', () => {
  it('带目录和扩展名的行内代码当作文件，行号一并解析', () => {
    expect(parseFileRef('src/utils/date.ts')).toEqual({ path: 'src/utils/date.ts' });
    expect(parseFileRef('packages/web-ui/src/App.tsx:12')).toEqual({ path: 'packages/web-ui/src/App.tsx', startLine: 12 });
    expect(parseFileRef('./scripts/build.mjs:3-9')).toEqual({ path: './scripts/build.mjs', startLine: 3, endLine: 9 });
    expect(parseFileRef('/abs/path/to/file.py')).toEqual({ path: '/abs/path/to/file.py' });
    expect(parseFileRef('@scope/pkg/index.d.ts')).toEqual({ path: '@scope/pkg/index.d.ts' });
  });

  it('普通代码不变成链接', () => {
    for (const text of ['Date.UTC', 'a/b', 'foo.bar()', 'npm run build', 'README.md', 'src/', 'x / y.z', 'https://example.com/a.js', 'src/a.ts:abc']) {
      expect(parseFileRef(text), text).toBeUndefined();
    }
  });
});
