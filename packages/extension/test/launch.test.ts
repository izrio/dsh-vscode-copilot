import { describe, expect, it } from 'vitest';
import { buildLaunchArgs, parseLaunchUrl, commandLine, isValidProfile, quoteForCmd } from '../src/runtime/launch.ts';
import { redactSecrets } from '../src/util/redact.ts';

describe('parseLaunchUrl', () => {
  it('解析 dsh web 打印的启动 URL', () => {
    expect(parseLaunchUrl('dsh web: http://127.0.0.1:40507/?token=abc_DEF-123')).toEqual({
      origin: 'http://127.0.0.1:40507',
      token: 'abc_DEF-123',
    });
  });

  it('忽略 ANSI 颜色控制符', () => {
    expect(parseLaunchUrl('\u001b[32mhttp://127.0.0.1:3080/?token=t0k\u001b[0m')?.token).toBe('t0k');
  });

  it('支持 IPv6 回环地址', () => {
    expect(parseLaunchUrl('http://[::1]:3080/?token=x')).toEqual({ origin: 'http://[::1]:3080', token: 'x' });
  });

  it('没有令牌的 URL 不算就绪信号', () => {
    expect(parseLaunchUrl('Web GUI URL: http://127.0.0.1:3080/')).toBeUndefined();
    expect(parseLaunchUrl('listening')).toBeUndefined();
  });
});

describe('buildLaunchArgs', () => {
  it('启动器参数在应用参数之前，只绑定回环地址，端口由系统分配', () => {
    expect(buildLaunchArgs('web', ['--patch', '/p.yml'])).toEqual([
      '--profile', 'web', '--patch', '/p.yml', '--no-open', '--host', '127.0.0.1', '--port', '0',
    ]);
  });
});

describe('redactSecrets', () => {
  it('脱敏启动令牌和认证 Cookie', () => {
    expect(redactSecrets('open http://127.0.0.1:1/?token=s3cr3t now')).toBe('open http://127.0.0.1:1/?token=<redacted> now');
    expect(redactSecrets('cookie: dsh-auth-127.0.0.1-1=abc.def; Path=/')).toBe('cookie: dsh-auth-127.0.0.1-1=<redacted>; Path=/');
  });

  it('没有凭据的文本保持不变', () => {
    expect(redactSecrets('Tokens prefixed with @ are paths')).toBe('Tokens prefixed with @ are paths');
    expect(redactSecrets('401 for key sk-0123456789abcdef0123')).toBe('401 for key sk-<redacted>');
    expect(redactSecrets('authorization: Bearer abc.def-ghi_123')).toBe('authorization: Bearer <redacted>');
    expect(redactSecrets('use the risk-free sk-ip option')).toBe('use the risk-free sk-ip option');
  });
});

describe('Windows 命令行', () => {
  it('.cmd 经 cmd.exe 运行时给带空格的路径和参数加引号', () => {
    expect(commandLine('C:\\Program Files\\dsh\\dsh.cmd', ['--profile', 'web', '--port', '0'], 'win32')).toEqual({
      file: '"C:\\Program Files\\dsh\\dsh.cmd"',
      args: ['--profile', 'web', '--port', '0'],
      shell: true,
    });
    expect(quoteForCmd('a "b" c')).toBe('"a ""b"" c"');
    expect(quoteForCmd('x&y')).toBe('"x&y"');
    expect(quoteForCmd('')).toBe('""');
  });

  it('其他情况不经过 shell，参数原样传递', () => {
    expect(commandLine('/usr/bin/dsh', ['a b'], 'linux')).toEqual({ file: '/usr/bin/dsh', args: ['a b'], shell: false });
    expect(commandLine('C:\\dsh\\dsh.exe', ['a b'], 'win32')).toEqual({ file: 'C:\\dsh\\dsh.exe', args: ['a b'], shell: false });
  });

  it('profile 只允许安全字符', () => {
    expect(isValidProfile('web')).toBe(true);
    expect(isValidProfile('my-profile.2')).toBe(true);
    expect(isValidProfile('web & calc')).toBe(false);
    expect(isValidProfile('')).toBe(false);
  });
});
