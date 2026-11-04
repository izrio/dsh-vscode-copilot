/**
 * 本地假模型：兼容 Anthropic Messages API（dsh 的 DeepSeek 适配器走 `POST /v1/messages`）。
 *
 * 用法：dsh 的 `$DSH_HOME/settings.yaml` 里设置
 *   llm-deepseek:
 *     apiKeyEnv: <环境变量名>
 *     baseURL: http://127.0.0.1:<port>
 *     thinking: disabled
 *
 * 行为由最近一条用户消息里的标记决定（见 SCRIPTS）；上一条消息是工具结果时，返回收尾文本。
 * 所有请求都会记录在 `requests` 里，方便测试断言。
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ToolUse {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type Script =
  | { readonly kind: 'text'; readonly chunks: readonly string[]; readonly delayMs?: number }
  | { readonly kind: 'tool'; readonly before?: string; readonly tool: ToolUse; readonly after: string }
  /** 依次调用多个工具（每次模型请求一个），全部完成后输出 after。 */
  | { readonly kind: 'tools'; readonly tools: readonly ToolUse[]; readonly after: string }
  /** 先输出 chunks，然后一直挂起，直到客户端断开（用于测试停止生成）。 */
  | { readonly kind: 'hold'; readonly chunks: readonly string[] };

export interface MockModel {
  readonly url: string;
  /** 收到的请求；`userText` 是最近一条用户文本（用于检查 dsh 实际发给模型的内容）。 */
  readonly requests: { readonly path: string; readonly marker?: string; readonly userText?: string }[];
  close(): Promise<void>;
}

interface AnthropicMessage {
  readonly role: string;
  readonly content: string | readonly { readonly type: string; readonly text?: string }[];
}

/**
 * 启动假模型。
 * @param scripts - 标记 → 脚本；最近一条用户文本包含某个标记时使用对应脚本，否则用 `default`。
 */
export async function startMockModel(scripts: Readonly<Record<string, Script>>): Promise<MockModel> {
  const requests: { path: string; marker?: string; userText?: string }[] = [];
  const openResponses = new Set<ServerResponse>();

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && (path === '/models' || path === '/v1/models')) {
      requests.push({ path });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }));
      return;
    }
    if (request.method !== 'POST' || path !== '/v1/messages') {
      requests.push({ path });
      response.writeHead(404);
      response.end();
      return;
    }
    let body = '';
    for await (const part of request) body += String(part);
    const payload = JSON.parse(body) as { model?: string; messages?: readonly AnthropicMessage[] };
    const messages = payload.messages ?? [];
    const marker = Object.keys(scripts).find((key) => key !== 'default' && lastUserText(messages).includes(key));
    requests.push({ path, ...(marker ? { marker } : {}), userText: lastUserText(messages) });
    const script = scripts[marker ?? 'default'] ?? { kind: 'text', chunks: ['OK'] };
    const afterTool = lastMessageIsToolResult(messages);
    const completedTools = toolResultsSinceUserText(messages);

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    openResponses.add(response);
    response.once('close', () => openResponses.delete(response));
    const sse = new Sse(response, payload.model ?? 'deepseek-flash');
    sse.start();

    if (script.kind === 'tools') {
      const next = script.tools[completedTools];
      if (next) {
        sse.toolUse(0, next);
        sse.stop('tool_use');
      } else {
        await sse.text(0, [script.after]);
        sse.stop('end_turn');
      }
      return;
    }
    if (script.kind === 'tool' && !afterTool) {
      let index = 0;
      if (script.before) await sse.text(index++, [script.before]);
      sse.toolUse(index, script.tool);
      sse.stop('tool_use');
      return;
    }
    if (script.kind === 'tool') {
      await sse.text(0, [script.after]);
      sse.stop('end_turn');
      return;
    }
    if (script.kind === 'hold') {
      await sse.text(0, script.chunks, 20, false);
      // 不结束：等客户端断开
      return;
    }
    await sse.text(0, script.chunks, script.delayMs ?? 30);
    sse.stop('end_turn');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock model: no address');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of openResponses) response.destroy();
        server.close(() => resolve());
      }),
  };
}

function lastUserText(messages: readonly AnthropicMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    const texts = message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '');
    if (texts.length > 0) return texts.join('\n');
  }
  return '';
}

/** 最近一条用户文本之后，已经完成了几次工具调用。 */
function toolResultsSinceUserText(messages: readonly AnthropicMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') break;
    const results = message.content.filter((block) => block.type === 'tool_result').length;
    if (results === 0 && message.content.some((block) => block.type === 'text')) break;
    count += results;
  }
  return count;
}

function lastMessageIsToolResult(messages: readonly AnthropicMessage[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === 'user' && Array.isArray(last.content) && last.content.some((block) => block.type === 'tool_result');
}

class Sse {
  constructor(
    private readonly response: ServerResponse,
    private readonly model: string,
  ) {}

  private event(data: Record<string, unknown>): void {
    if (this.response.destroyed) return;
    this.response.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  start(): void {
    this.event({
      type: 'message_start',
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
  }

  async text(index: number, chunks: readonly string[], delayMs = 30, close = true): Promise<void> {
    this.event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const chunk of chunks) {
      this.event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (close) this.event({ type: 'content_block_stop', index });
  }

  toolUse(index: number, tool: ToolUse): void {
    this.event({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name: tool.name, input: {} },
    });
    this.event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
    this.event({ type: 'content_block_stop', index });
  }

  stop(reason: 'end_turn' | 'tool_use'): void {
    this.event({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } });
    this.event({ type: 'message_stop' });
    this.response.end();
  }
}
