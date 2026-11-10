/**
 * 用真实 dsh 做测试时的隔离环境：临时 DSH_HOME、临时 git 工作区、本地假模型。
 * 不读取用户的会话和凭据，也不需要真实 API Key。供冒烟测试和界面端到端测试共用。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startMockModel, type MockModel, type Script } from '../mock-model/server.ts';

export interface DshTestEnv {
  readonly storage: string;
  readonly home: string;
  readonly workspace: string;
  readonly model: MockModel;
  /** 传给 dsh 进程的环境变量。 */
  readonly env: Record<string, string | undefined>;
  /** 启动器参数（关闭目标轮次驱动等）。 */
  readonly launcherArgs: readonly string[];
  cleanup(): Promise<void>;
}

export interface DshTestEnvOptions {
  readonly scripts: Readonly<Record<string, Script>>;
  /** 放在 PATH 最前面的目录，例如 Node 24 的 bin。 */
  readonly nodeBin?: string;
  /** 工作区里预先放的文件。 */
  readonly files?: Readonly<Record<string, string>>;
}

export async function createDshTestEnv(options: DshTestEnvOptions): Promise<DshTestEnv> {
  const storage = await mkdtemp(join(tmpdir(), 'dsh-test-'));
  const home = join(storage, 'home');
  const workspace = join(storage, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  for (const [path, content] of Object.entries(options.files ?? { 'README.md': '# m0 workspace\n' })) {
    await mkdir(join(workspace, path, '..'), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], { cwd: workspace });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  const model = await startMockModel(options.scripts);
  await writeFile(join(home, 'settings.yaml'), `llm-deepseek:\n  apiKeyEnv: DSH_TEST_API_KEY\n  baseURL: ${model.url}\n  thinking: disabled\n`);
  // 关掉目标轮次驱动，避免额外的模型请求干扰测试
  const patchPath = join(storage, 'test.patch.yml');
  await writeFile(patchPath, "- id: goal-round-driver\n  name: '@deepseek-ai/dsh-goal-round-driver'\n  disabled: true\n");

  return {
    storage,
    home,
    workspace,
    model,
    env: {
      PATH: [options.nodeBin, process.env.PATH].filter(Boolean).join(delimiter),
      HOME: home,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
      DSH_HOME: home,
      DSH_TEST_API_KEY: 'local-test-only',
    },
    launcherArgs: ['--patch', patchPath],
    cleanup: async () => {
      await model.close();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
