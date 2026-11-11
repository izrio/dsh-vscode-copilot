import { describe, expect, it } from 'vitest';
import { buildLaunchArgs, parseLaunchUrl, quoteForCmd, safeProfile, spawnSpec } from '../src/runtime/launch.ts';
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

describe('Windows 下启动 .cmd / .bat', () => {
  it('其他平台和 .exe 直接启动，不经过 shell', () => {
    expect(spawnSpec('/usr/bin/dsh', ['--version'], 'linux')).toEqual({ file: '/usr/bin/dsh', args: ['--version'] });
    expect(spawnSpec('C:\\tools\\dsh.exe', ['a b'], 'win32')).toEqual({ file: 'C:\\tools\\dsh.exe', args: ['a b'] });
  });

  it('.cmd 通过 cmd.exe 运行：路径里的空格和参数里的特殊字符都被转义', () => {
    const spec = spawnSpec('C:\\Users\\John Smith\\AppData\\Roaming\\npm\\dsh.cmd', ['--profile', 'web', '--port', '0'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    expect(spec.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // 空格被 ^ 转义，整条命令外面再包一层引号
    expect(spec.args[3]).toBe('"C:\\Users\\John^ Smith\\AppData\\Roaming\\npm\\dsh.cmd ^"--profile^" ^"web^" ^"--port^" ^"0^""');
  });

  it('参数里的 & | 引号不会变成另一条命令', () => {
    const quoted = quoteForCmd('a & calc | "x"');
    // 每个特殊字符前面都有 ^，cmd 把它们当普通字符
    expect(quoted).toBe('^"a^ ^&^ calc^ ^|^ \\^"x\\^"^"');
    expect(quoted.replace(/\^./gu, '')).not.toMatch(/[&|]/u);
  });

  it('profile 只接受字母、数字和 . _ -，其他值退回 web', () => {
    expect(safeProfile('web')).toBe('web');
    expect(safeProfile('my-profile_2.0')).toBe('my-profile_2.0');
    expect(safeProfile('web & calc')).toBe('web');
    expect(safeProfile('--patch')).toBe('web');
    expect(safeProfile('')).toBe('web');
  });
});
