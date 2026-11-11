/**
 * 输入框：一张整宽卡片，上面是上下文标签和多行输入，下面一行工具条（模型、权限、上下文用量、发送/停止）。
 * Enter 发送，Shift+Enter 换行；输入法组合输入时不拦截 Enter。草稿保存在 Webview 状态里。
 *
 * 补全：消息开头输入 `/` 列出斜杠命令；任意位置输入 `@` 列出文件和目录（候选由 Host 提供）。
 * 列表打开时 ↑↓ 选择，Enter / Tab 确认，Esc 关闭。
 *
 * 输入框顶边可以上下拖动调整高度（也可以聚焦后用 ↑↓），双击恢复随内容自动增高。高度保存在 Webview 状态里。
 *
 * 图片：粘贴（截图、复制的图片）或拖进输入框，显示成缩略图，随消息一起发送；可以只发图片不写文字。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { PromptImage } from '@harness-deck/shared';
// 只引入常量模块：包入口会把 zod 打进 Webview（zod 探测 new Function 会触发 CSP 违规）
import { IMAGE_MEDIA_TYPES, MAX_IMAGES, type ImageMediaType } from '@harness-deck/shared/limits';
import { registerLocalImage, showToast, useView } from '../store.ts';
import { ImageThumb } from './Images.tsx';
import { activeAtToken, formatFileMention, type ActiveAtToken } from '../mentions.ts';
import { loadState, postToHost, saveState } from '../vscode.ts';
import { Completion, type CompletionItem } from './Completion.tsx';
import { ContextChips } from './ContextChips.tsx';
import { ContextRing } from './ContextRing.tsx';
import { AgentIcon, ArrowUpIcon, CloseIcon, PlanIcon, StopIcon } from './icons.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PermissionPicker } from './PermissionPicker.tsx';
import { StatusDock } from './StatusDock.tsx';
import { useT } from '../i18n.ts';

/** 自动增高的上限；拖动设定的高度可以更高。 */
/** 单张图片的原始大小上限（dsh 还有自己的限制，超过时发送会报错）。 */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

let imageCounter = 0;
const nextImageId = () => `${Date.now().toString(36)}-${(++imageCounter).toString(36)}`;

/** 读成 data URL，返回 base64 部分和整个 data URL。 */
function readImage(file: File): Promise<{ data: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({ dataUrl, data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

const MAX_HEIGHT = 200;
const MIN_HEIGHT = 40;
const RESIZE_STEP = 16;

/** 拖动高度的上限：留出对话流的空间。 */
const resizeLimit = () => Math.max(120, Math.round(window.innerHeight * 0.7));
const clampHeight = (height: number) => Math.round(Math.min(Math.max(height, MIN_HEIGHT), resizeLimit()));
const SEARCH_DELAY_MS = 60;

type Trigger = { readonly kind: 'command'; readonly query: string } | { readonly kind: 'file'; readonly token: ActiveAtToken; readonly start: number };

/**
 * 斜杠命令补全的候选：不区分大小写，名字开头匹配的在前，名字中间匹配的在后（输入 review 也能找到 code-review）。
 * 同一档里保持原来的顺序（插件模板、底层命令、skill）。
 */
export function matchCommands<T extends { readonly name: string }>(commands: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts: T[] = [];
  const contains: T[] = [];
  for (const command of commands) {
    const at = command.name.toLowerCase().indexOf(q);
    if (at === 0) starts.push(command);
    else if (at > 0) contains.push(command);
  }
  return [...starts, ...contains];
}

/** 光标前的文本决定要不要打开补全。 */
function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  // 命令名可以带 : . 等（插件里的 skill：engineering:code-review），到空白为止
  const command = /^\/(\S*)$/u.exec(before);
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
  const prefill = useView((s) => s.prefill);
  const context = useView((s) => s.context);
  const commands = useView((s) => s.commands);
  const candidates = useView((s) => s.fileCandidates);
  const t = useT();
  const tabKey = useView((s) => s.tabs.active);
  /** 待发送的图片；切换标签时按标签暂存。 */
  const [images, setImages] = useState<PromptImage[]>([]);
  const imageStash = useRef(new Map<string, PromptImage[]>());
  const [text, setText] = useState(() => loadState().draft ?? '');
  /** 草稿属于哪个标签；切换标签时存下当前草稿，换成目标标签的草稿。 */
  const draftOwner = useRef(tabKey);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  /** 按 Esc 关掉补全时的文本；文本变化后才重新打开。 */
  const [dismissedFor, setDismissedFor] = useState<string | undefined>();
  const [requestId, setRequestId] = useState(-1);
  /** 被点过的当前编辑器标签：与默认附带状态相反。换了文件或选区自动恢复默认。 */
  const [toggledKey, setToggledKey] = useState<string | undefined>();
  const ref = useRef<HTMLTextAreaElement>(null);
  /** 拖动设定的高度：作为最小高度，内容更多时继续增高到它和 MAX_HEIGHT 中较大的那个。 */
  const [inputHeight, setInputHeight] = useState<number | undefined>(() => loadState().inputHeight);

  useEffect(() => {
    saveState({ draft: text });
  }, [text]);

  useEffect(() => {
    const previous = draftOwner.current;
    draftOwner.current = tabKey;
    // 还没收到快照时（key 为空）恢复的草稿就属于当前标签
    if (!previous || previous === tabKey) return;
    const { [tabKey]: next = '', ...rest } = loadState().drafts ?? {};
    saveState({ drafts: text.trim() ? { ...rest, [previous]: text } : rest });
    setText(next);
    imageStash.current.set(previous, images);
    setImages(imageStash.current.get(tabKey) ?? []);
    imageStash.current.delete(tabKey);
    setCaret(next.length);
  }, [tabKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const max = Math.max(MAX_HEIGHT, inputHeight ?? 0);
    el.style.maxHeight = `${max}px`;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, inputHeight ?? 0), max)}px`;
  }, [text, inputHeight]);

  const commitHeight = (height: number | undefined) => {
    setInputHeight(height);
    saveState({ inputHeight: height });
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = el.getBoundingClientRect().height;
    let latest = startHeight;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const move = (e: globalThis.PointerEvent) => {
      latest = clampHeight(startHeight + (startY - e.clientY));
      moved = true;
      setInputHeight(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing');
      if (moved) saveState({ inputHeight: latest });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const current = inputHeight ?? ref.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
    commitHeight(clampHeight(current + (event.key === 'ArrowUp' ? RESIZE_STEP : -RESIZE_STEP)));
  };

  useEffect(() => {
    ref.current?.focus();
  }, [focusRequests, session.id]);

  // 「编辑后重发」、示例任务：换掉输入框里的内容；消息没发出去时放回原文，这期间新写的内容接在后面。光标放到末尾
  useEffect(() => {
    if (prefill.n === 0) return;
    const current = ref.current?.value ?? '';
    const next = prefill.mode === 'restore' && current.trim() ? `${prefill.text}\n${current}` : prefill.text;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.length, next.length);
    });
  }, [prefill]);

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
      return matchCommands(commands, trigger.query).map((c) => ({
        key: `${c.source}:${c.name}`,
        icon: 'command',
        label: `/${c.name}`,
        ...(c.source === 'skill' ? { tag: 'skill' } : {}),
        ...(c.hint ? { hint: c.hint } : {}),
        detail: c.description,
      }));
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
      : trigger?.kind === 'command' && commands.some((c) => c.name.toLowerCase() === trigger.query.toLowerCase());
  // 文件补全：结果还没回来时也打开，显示"正在搜索"
  const menuOpen = trigger !== undefined && !complete && (items.length > 0 || trigger.kind === 'file');

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
      const command = matchCommands(commands, trigger.query)[index];
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

  const addImages = async (files: readonly File[]) => {
    let room = MAX_IMAGES - images.length;
    const added: PromptImage[] = [];
    for (const file of files) {
      if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type)) {
        showToast('error', t('image.unsupported', file.type || file.name));
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        showToast('error', t('image.tooLarge', file.name || t('image.label'), MAX_IMAGE_BYTES / 1024 / 1024));
        continue;
      }
      if (room <= 0) {
        showToast('error', t('image.tooMany', MAX_IMAGES));
        break;
      }
      try {
        const { data, dataUrl } = await readImage(file);
        const localId = nextImageId();
        registerLocalImage(localId, dataUrl);
        // 截图粘贴时文件名总是 image.png，不当作名字
        const name = file.name && file.name !== 'image.png' ? file.name : undefined;
        added.push({ localId, mediaType: file.type as ImageMediaType, data, ...(name ? { name } : {}) });
        room--;
      } catch {
        showToast('error', t('image.failed'));
      }
    }
    if (added.length) setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
  };

  const imageFiles = (list: DataTransferItemList | FileList | null | undefined): File[] => {
    if (!list) return [];
    if ('length' in list && list.length > 0 && list[0] instanceof File) return [...(list as FileList)].filter((f) => f.type.startsWith('image/'));
    return [...(list as DataTransferItemList)]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  };

  /** 子代理的对话：只能查看。 */
  const readOnly = session.subagentOf !== undefined;
  const canSend = connected && !readOnly && (text.trim().length > 0 || images.length > 0);
  const send = () => {
    if (!canSend) return;
    postToHost({ type: 'sendMessage', payload: { text: text.trim(), includeActive, ...(images.length ? { images } : {}) } });
    setText('');
    setCaret(0);
    setImages([]);
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
      return;
    }
    // Esc 停止生成（补全列表打开时 Esc 先关列表，输入法组合输入时不拦截）
    if (event.key === 'Escape' && !composing && session.running && !readOnly) {
      event.preventDefault();
      postToHost({ type: 'interrupt', payload: {} });
    }
  };

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0);

  // 运行中输入框仍可发送（消息排进队列，当前回复结束后处理），所以写了内容时发送和停止两个按钮都在
  const showStop = session.running && !readOnly;
  const showSend = !showStop || text.trim().length > 0 || images.length > 0;
  return (
    <div className="composer-wrap">
      <StatusDock />
      {session.subagentOf ? (
        <div className="subagent-strip" data-testid="subagent-strip">
          <AgentIcon />
          <span>{t('subagent.readOnlyHint')}</span>
          <button type="button" className="link-button" onClick={() => postToHost({ type: 'switchSession', payload: { sessionId: session.subagentOf!.parentId } })}>
            {t('subagent.backToParent')}
          </button>
        </div>
      ) : null}
      {menuOpen && trigger ? (
        <Completion
          items={items}
          selected={selected}
          onSelect={accept}
          onHover={setSelected}
          label={trigger.kind === 'command' ? t('completion.commands') : t('completion.files')}
          {...(trigger.kind === 'file' ? { empty: t('completion.noFiles') } : {})}
          {...(trigger.kind === 'file' && requestId !== candidates.requestId ? { loading: t('completion.searching') } : {})}
        />
      ) : null}
      <div
        className="composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = imageFiles(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          void addImages(files);
        }}
      >
        <div
          className="composer__resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('composer.resize')}
          title={t('composer.resize')}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => commitHeight(undefined)}
          onKeyDown={resizeByKey}
          data-testid="composer-resize"
        />
        <ContextChips active={active} included={includeActive} onToggle={() => active && setToggledKey(toggledKey === active.key ? undefined : active.key)} pinned={context.pinned} />
        {images.length ? (
          <div className="composer__images" data-testid="composer-images">
            {images.map((image) => (
              <ImageThumb key={image.localId} image={image} size="small" onRemove={() => setImages((current) => current.filter((i) => i.localId !== image.localId))} />
            ))}
          </div>
        ) : null}
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
          onPaste={(event) => {
            const files = imageFiles(event.clipboardData.items);
            if (files.length === 0) return;
            // 同时有文字时（例如从文档里复制）照常粘贴文字，图片一并附上
            if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
            void addImages(files);
          }}
          disabled={readOnly}
          placeholder={
            readOnly
              ? t('subagent.readOnlyHint')
              : connected
                ? session.running
                  ? t('composer.placeholderRunning')
                  : t('composer.placeholder')
                : t('composer.placeholderOffline')
          }
          rows={1}
          aria-label={t('composer.label')}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          {...(menuOpen ? { 'aria-controls': 'composer-completion', 'aria-activedescendant': `completion-${selected}` } : {})}
        />
        <div className="composer__toolbar">
          <ModelPicker disabled={!connected || readOnly} />
          <PermissionPicker disabled={!connected || readOnly} />
          {session.planMode ? (
            <button
              type="button"
              className="toolbar-button plan-badge"
              title={t('composer.planTitle')}
              onClick={() => postToHost({ type: 'sendMessage', payload: { text: '/plan off' } })}
              data-testid="plan-badge"
            >
              <PlanIcon />
              <span className="toolbar-button__text">{t('composer.plan')}</span>
              <CloseIcon />
            </button>
          ) : null}
          {session.contextUsage !== undefined ? <ContextRing usage={session.contextUsage} {...(session.contextTokens ? { tokens: session.contextTokens } : {})} /> : null}
          <span className="composer__spacer" />
          {showStop ? (
            <button
              type="button"
              className={`send-button send-button--stop ${showSend ? 'send-button--secondary' : ''}`}
              onClick={() => postToHost({ type: 'interrupt', payload: {} })}
              aria-label={t('composer.stop')}
              title={t('composer.stopHint')}
            >
              <StopIcon />
            </button>
          ) : null}
          {showSend ? (
            <button type="button" className="send-button" disabled={!canSend} onClick={send} aria-label={t('composer.send')} title={t('composer.sendTitle')}>
              <ArrowUpIcon />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
