/**
 * 输入框：一张整宽卡片，上面是上下文标签和多行输入，下面一行工具条（模型、权限、上下文用量、发送/停止）。
 * Enter 发送，Shift+Enter 换行；输入法组合输入时不拦截 Enter。草稿保存在 Webview 状态里。
 *
 * 补全：消息开头输入 `/` 列出斜杠命令；任意位置输入 `@` 列出文件和目录（候选由 Host 提供）。
 * 列表打开时 ↑↓ 选择，Enter / Tab 确认，Esc 关闭。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useView } from '../store.ts';
import { activeAtToken, formatFileMention, type ActiveAtToken } from '../mentions.ts';
import { loadState, postToHost, saveState } from '../vscode.ts';
import { Completion, type CompletionItem } from './Completion.tsx';
import { ContextChips } from './ContextChips.tsx';
import { ArrowUpIcon, CloseIcon, PlanIcon, StopIcon } from './icons.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PermissionPicker } from './PermissionPicker.tsx';

const MAX_HEIGHT = 200;
const SEARCH_DELAY_MS = 60;

type Trigger = { readonly kind: 'command'; readonly query: string } | { readonly kind: 'file'; readonly token: ActiveAtToken; readonly start: number };

/** 光标前的文本决定要不要打开补全。 */
function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const command = /^\/([\w-]*)$/u.exec(before);
  if (command) return { kind: 'command', query: command[1] ?? '' };
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const token = activeAtToken(line);
  return token ? { kind: 'file', token, start: caret - token.prefix.length } : undefined;
}

let nextRequestId = 0;

export function Composer() {
  const session = useView((s) => s.session);
  const connected = useView((s) => s.connection === 'connected');
  const focusRequests = useView((s) => s.focusRequests);
  const dirtyFiles = useView((s) => s.workspace.dirtyFiles);
  const context = useView((s) => s.context);
  const commands = useView((s) => s.commands);
  const candidates = useView((s) => s.fileCandidates);
  const [text, setText] = useState(() => loadState().draft ?? '');
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  /** 按 Esc 关掉补全时的文本；文本变化后才重新打开。 */
  const [dismissedFor, setDismissedFor] = useState<string | undefined>();
  const [requestId, setRequestId] = useState(-1);
  /** 被点过的当前编辑器标签：与默认附带状态相反。换了文件或选区自动恢复默认。 */
  const [toggledKey, setToggledKey] = useState<string | undefined>();
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

  const trigger = dismissedFor === text ? undefined : triggerAt(text, caret);
  const fileQuery = trigger?.kind === 'file' ? trigger.token.query : undefined;

  // @ 补全：输入停顿后再向 Host 要候选
  useEffect(() => {
    if (fileQuery === undefined || !connected) return;
    const timer = setTimeout(() => {
      const id = ++nextRequestId;
      setRequestId(id);
      postToHost({ type: 'searchFiles', payload: { requestId: id, query: fileQuery } });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fileQuery, connected]);

  const items: CompletionItem[] = useMemo(() => {
    if (trigger?.kind === 'command') {
      return commands
        .filter((c) => c.name.startsWith(trigger.query.toLowerCase()))
        .map((c) => ({ key: `${c.source}:${c.name}`, icon: 'command', label: `/${c.name}`, ...(c.hint ? { hint: c.hint } : {}), detail: c.description }));
    }
    if (trigger?.kind === 'file' && candidates.requestId >= 0) {
      return candidates.items.map((c) => {
        const slash = c.path.lastIndexOf('/');
        return {
          key: `${c.kind}:${c.path}`,
          icon: c.kind,
          label: slash >= 0 ? c.path.slice(slash + 1) : c.path,
          ...(slash >= 0 ? { detail: c.path.slice(0, slash) } : {}),
        };
      });
    }
    return [];
  }, [trigger?.kind, trigger?.kind === 'command' ? trigger.query : undefined, commands, candidates]);

  useEffect(() => setSelected(0), [items.length, trigger?.kind, fileQuery]);

  // 光标停在一个已经完整的文件引用或命令名后面时不打开（否则 Enter 会被补全吃掉，发不出消息）
  const complete =
    trigger?.kind === 'file'
      ? candidates.items.some((c) => c.kind === 'file' && c.path === trigger.token.query)
      : trigger?.kind === 'command' && commands.some((c) => c.name === trigger.query);
  const menuOpen = trigger !== undefined && !complete && (items.length > 0 || (trigger.kind === 'file' && requestId === candidates.requestId));

  const replaceRange = (start: number, end: number, insertion: string) => {
    const next = text.slice(0, start) + insertion + text.slice(end);
    const position = start + insertion.length;
    setText(next);
    setCaret(position);
    requestAnimationFrame(() => ref.current?.setSelectionRange(position, position));
  };

  const accept = (index: number) => {
    if (!trigger) return;
    if (trigger.kind === 'command') {
      const command = commands.filter((c) => c.name.startsWith(trigger.query.toLowerCase()))[index];
      if (command) replaceRange(0, caret, `/${command.name} `);
      return;
    }
    const candidate = candidates.items[index];
    if (!candidate) return;
    const mention = formatFileMention(candidate, trigger.token.quoted);
    if (!mention) return;
    // 目录不加空格，补全继续列出目录内容
    replaceRange(trigger.start, caret, candidate.kind === 'file' ? `${mention} ` : mention);
  };

  const active = context.active;
  const includeActive = active ? context.includeActiveByDefault !== (toggledKey === active.key) : true;

  const canSend = connected && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    postToHost({ type: 'sendMessage', payload: { text: text.trim(), includeActive } });
    setText('');
    setCaret(0);
    setToggledKey(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (menuOpen && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (items.length) setSelected((selected + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (items.length) {
          event.preventDefault();
          accept(selected);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedFor(text);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      send();
    }
  };

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0);

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
      {menuOpen && trigger ? (
        <Completion
          items={items}
          selected={selected}
          onSelect={accept}
          onHover={setSelected}
          label={trigger.kind === 'command' ? '斜杠命令' : '引用文件'}
          {...(trigger.kind === 'file' ? { empty: '没有匹配的文件' } : {})}
        />
      ) : null}
      <div className="composer">
        <ContextChips active={active} included={includeActive} onToggle={() => active && setToggledKey(toggledKey === active.key ? undefined : active.key)} pinned={context.pinned} />
        <textarea
          ref={ref}
          className="composer__input"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={onKeyDown}
          placeholder={
            connected ? (session.running ? '继续输入，会在当前回复结束后发送' : '描述任务，@ 引用文件，/ 使用命令') : '等待 dsh 连接…'
          }
          rows={1}
          aria-label="消息"
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          {...(menuOpen ? { 'aria-controls': 'composer-completion', 'aria-activedescendant': `completion-${selected}` } : {})}
        />
        <div className="composer__toolbar">
          <ModelPicker disabled={!connected} />
          <PermissionPicker disabled={!connected} />
          {session.planMode ? (
            <button
              type="button"
              className="toolbar-button plan-badge"
              title="计划模式：dsh 先做计划，不修改文件。点击退出"
              onClick={() => postToHost({ type: 'sendMessage', payload: { text: '/plan off' } })}
              data-testid="plan-badge"
            >
              <PlanIcon />
              <span className="toolbar-button__text">计划模式</span>
              <CloseIcon />
            </button>
          ) : null}
          {session.contextUsage !== undefined ? (
            <span className="context-usage" title={`上下文已用 ${Math.round(session.contextUsage * 100)}%`}>
              {Math.max(1, Math.round(session.contextUsage * 100))}%
            </span>
          ) : null}
          <span className="composer__spacer" />
          {showStop ? (
            <button type="button" className="send-button send-button--stop" onClick={() => postToHost({ type: 'interrupt', payload: {} })} aria-label="停止生成" title="停止生成">
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
