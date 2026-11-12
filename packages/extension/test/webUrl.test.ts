import { describe, expect, it } from 'vitest';
import { webUIUrl } from '../src/util/webUrl.ts';

const TOKEN = 'ko1Ug0xjxEhSmjLy_vhvYMjqVhOVJ0smq9RIEkbqqiw';

describe('浏览器打开 dsh 的地址', () => {
  it('本地：和 dsh web 打印的一样，token 前是 = 而不是 %3D', async () => {
    const url = await webUIUrl('http://127.0.0.1:3080', TOKEN, async (base) => base);
    expect(url).toBe(`http://127.0.0.1:3080/?token=${TOKEN}`);
    expect(new URL(url).searchParams.get('token')).toBe(TOKEN);
  });

  it('远程：用 VS Code 转发后的地址', async () => {
    expect(await webUIUrl('http://127.0.0.1:41234', TOKEN, async () => 'http://localhost:53001/')).toBe(`http://localhost:53001/?token=${TOKEN}`);
  });

  it('转发失败时退回本机地址', async () => {
    const lines: string[] = [];
    const url = await webUIUrl('http://127.0.0.1:41234', TOKEN, () => Promise.reject(new Error('no tunnel')), (line) => lines.push(line));
    expect(url).toBe(`http://127.0.0.1:41234/?token=${TOKEN}`);
    expect(lines).toHaveLength(1);
  });
});
