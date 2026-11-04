/**
 * 输入框：一张整宽卡片，上面多行输入，下面一行工具条（模型、上下文用量、发送/停止）。
 * Enter 发送，Shift+Enter 换行；输入法组合输入时不拦截 Enter。草稿保存在 Webview 状态里。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useView } from '../store.ts';
import { loadState, postToHost, saveState } from '../vscode.ts';
import { ArrowUpIcon, StopIcon } from './icons.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PermissionPicker } from './PermissionPicker.tsx';

const MAX_HEIGHT = 200;

export function Composer() {
  const session = useView((s) => s.session);
  const connected = useView((s) => s.connection === 'connected');
  const focusRequests = useView((s) => s.focusRequests);
  const dirtyFiles = useView((s) => s.workspace.dirtyFiles);
  const [text, setText] = useState(() => loadState().draft ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    saveState({ draft: text });
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  useEffect(() => {
    ref.current?.focus();
  }, [focusRequests, session.id]);

  const canSend = connected && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    postToHost({ type: 'sendMessage', payload: { text: text.trim() } });
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      send();
    }
  };

  // 运行中输入框仍可发送：dsh 会把消息排进队列，当前回复结束后处理
  const showStop = session.running && text.trim().length === 0;
  return (
    <div className="composer-wrap">
      {dirtyFiles > 0 ? (
        <div className="dirty-strip" data-testid="dirty-strip">
          <span>{dirtyFiles} 个文件有未保存的修改，dsh 读取和修改的是磁盘上的版本</span>
          <button type="button" className="link-button" onClick={() => postToHost({ type: 'saveAll', payload: {} })}>
            全部保存
          </button>
        </div>
      ) : null}
      <div className="composer">
        <textarea
          ref={ref}
          className="composer__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={connected ? (session.running ? '继续输入，会在当前回复结束后发送' : '描述任务，Enter 发送，Shift+Enter 换行') : '等待 dsh 连接…'}
          rows={1}
          aria-label="消息"
        />
        <div className="composer__toolbar">
          <ModelPicker disabled={!connected} />
          <PermissionPicker disabled={!connected} />
          {session.contextUsage !== undefined ? (
            <span className="context-usage" title={`上下文已用 ${Math.round(session.contextUsage * 100)}%`}>
              {Math.max(1, Math.round(session.contextUsage * 100))}%
            </span>
          ) : null}
          <span className="composer__spacer" />
          {showStop ? (
            <button
              type="button"
              className="send-button send-button--stop"
              onClick={() => postToHost({ type: 'interrupt', payload: {} })}
              aria-label="停止生成"
              title="停止生成"
            >
              <StopIcon />
            </button>
          ) : (
            <button type="button" className="send-button" disabled={!canSend} onClick={send} aria-label="发送" title="发送（Enter）">
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
