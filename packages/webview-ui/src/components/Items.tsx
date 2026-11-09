/** 对话流里的各类条目。遵循 docs/DESIGN.md 3.1：没有角色标签，工具调用压成一行，没有内容就不渲染。 */
import { memo, useState, type ReactNode } from 'react';
import type { ChangedFileView, DiffRef, Item, LineStats } from '@harness-deck/shared';
import { splitMentions } from '../mentions.ts';
import { diffKey, openDiff as trackDiff, requestPrefill, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { attachmentLabel, openAttachment } from './ContextChips.tsx';
import { Markdown } from './Markdown.tsx';
import { TurnDone } from './RunStatus.tsx';
import { ImageThumb } from './Images.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DiffIcon,
  ErrorIcon,
  FastForwardIcon,
  FileEditIcon,
  FileIcon,
  GlobeIcon,
  InfoIcon,
  KeyIcon,
  PencilIcon,
  PlanIcon,
  QuestionIcon,
  RefreshIcon,
  SearchIcon,
  SelectionIcon,
  SendIcon,
  SlashIcon,
  SpinnerIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
} from './icons.tsx';
import { useT } from '../i18n.ts';

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>;

export const ItemView = memo(function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'assistant':
      return <AssistantMessage item={item} />;
    case 'activity':
      if (item.variant === 'subagent' && item.subagent) return <SubagentRow item={item} />;
      return item.variant === 'edit' ? <EditRow item={item} /> : <ActivityRow item={item} />;
    case 'explore':
      return <ExploreRow item={item} />;
    case 'changes':
      return <ChangesCard item={item} />;
    case 'notice':
      return <Notice item={item} />;
    case 'turnDone':
      return <TurnDone item={item} />;
  }
});

function UserBubble({ item }: { item: Of<'user'> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  if (editing && item.queue) return <QueueEditor item={item} onDone={() => setEditing(false)} />;
  return (
    <div className={`user ${item.pending ? `user--${item.pending}` : ''}`}>
      {item.text ? (
        <div className="user__bubble">
          <UserText text={item.text} />
        </div>
      ) : null}
      {item.images?.length ? (
        <div className="user__images">
          {item.images.map((image, index) => (
            <ImageThumb key={image.attachmentId ?? image.localId ?? index} image={image} />
          ))}
        </div>
      ) : null}
      {item.attachments?.length ? (
        <div className="user__attachments">
          {item.attachments.map((a) => (
            <button key={attachmentLabel(a) + a.path} type="button" className="chip chip--small" onClick={() => openAttachment(a)} title={t('common.open', a.path)}>
              {a.kind === 'selection' ? <SelectionIcon /> : <FileIcon />}
              <span className="chip__label">{attachmentLabel(a)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {item.pending === 'sending' ? (
        <div className="user__meta">
          <SpinnerIcon />
          <span>{t('user.sending')}</span>
        </div>
      ) : null}
      {item.pending === 'queued' ? <QueuedMeta item={item} onEdit={() => setEditing(true)} /> : null}
      {!item.pending && item.text ? <UserActions text={item.text} /> : null}
      {item.pending === 'failed' ? (
        <div className="user__meta user__meta--error">
          <span>{item.error ? t('user.failedWith', item.error) : t('user.failed')}</span>
          <button type="button" className="link-button" onClick={() => item.requestId && postToHost({ type: 'retryPending', payload: { requestId: item.requestId } })}>
            <RefreshIcon />
            {t('user.retry')}
          </button>
          <button type="button" className="link-button" onClick={() => item.requestId && postToHost({ type: 'discardPending', payload: { requestId: item.requestId } })}>
            <TrashIcon />
            {t('common.delete')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 消息下面的操作：灰色小图标，悬停变亮；文字放在提示和无障碍名称里。 */
function IconAction({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="msg-action" aria-label={label} title={title ?? label} onClick={onClick}>
      {children}
    </button>
  );
}

/** 已发送的消息：悬停时显示复制、编辑后重发。 */
function UserActions({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="user__actions">
      <IconAction
        label={copied ? t('user.copied') : t('user.copy')}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_200);
          })
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconAction>
      <IconAction label={t('user.editResend')} title={t('user.editResendTitle')} onClick={() => requestPrefill(text)}>
        <PencilIcon />
      </IconAction>
    </div>
  );
}

/** 排队中的消息：在 dsh 队列里时可以编辑、插队（在当前回复的下一步送达）、删除。状态一行文字，操作是一排图标。 */
function QueuedMeta({ item, onEdit }: { item: Of<'user'>; onEdit: () => void }) {
  const t = useT();
  const running = useView((s) => s.session.running);
  const queue = item.queue;
  if (!queue) return <div className="user__meta">{t('queue.waiting')}</div>;
  const act = (action: 'remove' | 'steer' | 'send') => postToHost({ type: 'queueAction', payload: { action, itemId: queue.itemId } });
  if (!running) {
    // 停止生成后 dsh 保留队列，但要等下一条消息才一起送达
    return (
      <div className="user__meta user__meta--queued" data-testid="queued-meta">
        <span className="user__status">{t('queue.stopped')}</span>
        <span className="user__tools">
          <IconAction label={t('queue.sendNow')} onClick={() => act('send')}>
            <SendIcon />
          </IconAction>
          <IconAction label={t('common.edit')} onClick={onEdit}>
            <PencilIcon />
          </IconAction>
          <IconAction label={t('common.delete')} onClick={() => act('remove')}>
            <TrashIcon />
          </IconAction>
        </span>
      </div>
    );
  }
  return (
    <div className="user__meta user__meta--queued" data-testid="queued-meta">
      <span className="user__status">{queue.target === 'next-step' ? t('queue.steered') : t('queue.waiting')}</span>
      <span className="user__tools">
        <IconAction label={t('common.edit')} onClick={onEdit}>
          <PencilIcon />
        </IconAction>
        {queue.target === 'next-turn' ? (
          <IconAction label={t('queue.steer')} title={t('queue.steerTitle')} onClick={() => act('steer')}>
            <FastForwardIcon />
          </IconAction>
        ) : null}
        <IconAction label={t('common.delete')} onClick={() => act('remove')}>
          <TrashIcon />
        </IconAction>
      </span>
    </div>
  );
}

function QueueEditor({ item, onDone }: { item: Of<'user'>; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState(item.text);
  const save = () => {
    if (item.queue && text.trim() && text.trim() !== item.text) {
      postToHost({ type: 'queueAction', payload: { action: 'edit', itemId: item.queue.itemId, text: text.trim() } });
    }
    onDone();
  };
  return (
    <div className="user user--queued">
      <textarea
        className="queue-editor"
        value={text}
        autoFocus
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        aria-label={t('queue.editLabel')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            onDone();
          }
        }}
      />
      <div className="user__meta">
        <button type="button" className="link-button" onClick={save}>
          <CheckIcon />
          {t('common.save')}
        </button>
        <button type="button" className="link-button" onClick={onDone}>
          <CloseIcon />
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

/** 用户消息正文：`@路径` 显示成可点击的引用。 */
function UserText({ text }: { text: string }) {
  const t = useT();
  return (
    <>
      {splitMentions(text).map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <button key={index} type="button" className="mention" onClick={() => postToHost({ type: 'openFile', payload: { path: part.path } })} title={t('common.open', part.path)}>
            {part.text}
          </button>
        ),
      )}
    </>
  );
}

function AssistantMessage({ item }: { item: Of<'assistant'> }) {
  return (
    <div className={`assistant ${item.streaming && item.markdown ? 'assistant--streaming' : ''}`}>
      {item.reasoning ? <Reasoning text={item.reasoning} active={item.streaming && !item.markdown} /> : null}
      {item.markdown ? <Markdown text={item.markdown} /> : null}
      {item.streaming && item.markdown ? <span className="cursor" aria-hidden /> : null}
    </div>
  );
}

/** 推理过程：进行中只显示一行"思考中"，结束后折叠成一行，点开查看。 */
function Reasoning({ text, active }: { text: string; active: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button type="button" className="reasoning__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRightIcon className={`chevron ${open ? 'chevron--open' : ''}`} />
        <span className={active ? 'shimmer' : undefined}>{active ? t('reasoning.active') : t('reasoning.done')}</span>
      </button>
      {open ? <div className="reasoning__body">{text}</div> : null}
    </div>
  );
}

/** 打开 Diff；Host 打开前对应的行显示加载中，重复点击不会重复请求。 */
export const openDiff = (ref: DiffRef) => trackDiff(ref, (token) => postToHost({ type: 'openDiff', payload: { ref, token } }));

/** 这个 Diff 正在打开。 */
export function useDiffOpening(ref: DiffRef | undefined): boolean {
  return useView((s) => ref !== undefined && s.openingDiff?.key === diffKey(ref));
}

function StatusIcon({ status, icon }: { status: 'running' | 'ok' | 'error'; icon: ReactNode }) {
  return <span className="activity__icon">{status === 'running' ? <SpinnerIcon /> : status === 'error' ? <ErrorIcon /> : icon}</span>;
}

/** 命令和其他工具：一行摘要，点开看输出。 */
function ActivityRow({ item }: { item: Of<'activity'> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, ...rest] = item.label.split('  ');
  const detail = rest.join('  ');
  const expandable = Boolean(item.output);
  const command = item.variant === 'command';
  return (
    <div className={`activity activity--${item.status} ${command ? 'activity--command' : ''}`}>
      <button
        type="button"
        className="activity__row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(!open)}
        title={item.label}
      >
        <StatusIcon status={item.status} icon={command ? <TerminalIcon /> : <GenericToolIcon tool={item.tool} />} />
        {command ? (
          <span className="activity__name">{item.status === 'running' ? t('command.running') : t('command.done')}</span>
        ) : (
          <span className="activity__name">{name}</span>
        )}
        {(command ? detail || name : detail) ? <span className="activity__detail">{command ? detail || name : detail}</span> : null}
      </button>
      {open && item.output ? <pre className="activity__output">{item.output}</pre> : null}
    </div>
  );
}

/** 通用工具的图标：斜杠命令、提问、计划、网页类工具各有自己的图标。 */
function GenericToolIcon({ tool }: { tool: string }) {
  if (tool === 'slash') return <SlashIcon />;
  if (tool === 'ask_user_question') return <QuestionIcon />;
  if (tool === 'exit_plan_mode') return <PlanIcon />;
  if (tool.startsWith('web_')) return <GlobeIcon />;
  return <ToolIcon />;
}

/** 文件修改：「已编辑 src/a.ts +3 −1」，点击打开 Diff。 */
function EditRow({ item }: { item: Of<'activity'> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const verb = item.status === 'running' ? t('edit.running') : item.status === 'error' ? t('edit.failed') : item.created ? t('edit.created') : t('edit.done');
  const diff = item.diff;
  const opening = useDiffOpening(diff);
  const onClick = () => (diff ? openDiff(diff) : item.output ? setOpen(!open) : undefined);
  return (
    <div className={`activity activity--${item.status} activity--edit`}>
      <button
        type="button"
        className="activity__row"
        disabled={!diff && !item.output}
        aria-expanded={!diff && item.output ? open : undefined}
        onClick={onClick}
        title={diff ? t('edit.view', item.label) : item.label}
      >
        <StatusIcon status={opening ? 'running' : item.status} icon={<FileEditIcon />} />
        <span className="activity__name">{verb}</span>
        <span className={`activity__detail activity__file ${diff ? 'activity__file--link' : ''}`}>{item.label}</span>
        {item.stats ? <Stats stats={item.stats} /> : null}
      </button>
      {open && item.output ? <pre className="activity__output">{item.output}</pre> : null}
    </div>
  );
}

/** 增删行数；只有一侧有变化时不显示另一侧的 0。 */
function Stats({ stats }: { stats: Partial<LineStats> }) {
  const { additions, deletions } = stats;
  if (additions === undefined && deletions === undefined) return null;
  const both = !additions && !deletions;
  return (
    <span className="stats">
      {additions !== undefined && (additions > 0 || both) ? <span className="stats__add">+{additions}</span> : null}
      {deletions !== undefined && deletions > 0 ? <span className="stats__del">−{deletions}</span> : null}
    </span>
  );
}

/** 连续的只读操作：「已浏览 读取 3 个文件，搜索 1 次」，点开看每一步。 */
function ExploreRow({ item }: { item: Of<'explore'> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className={`activity activity--${item.status}`}>
      <button type="button" className="activity__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StatusIcon status={item.status} icon={<SearchIcon />} />
        <span className="activity__name">{item.status === 'running' ? t('explore.running') : t('explore.done')}</span>
        <span className="activity__detail activity__detail--plain">{item.summary}</span>
        <ChevronRightIcon className={`chevron activity__chevron ${open ? 'chevron--open' : ''}`} />
      </button>
      {open ? (
        <ul className="explore__list">
          {item.entries.map((entry) => {
            const [name, ...rest] = entry.label.split('  ');
            return (
              <li key={entry.id} className={`explore__entry explore__entry--${entry.status}`}>
                <span className="explore__tool">{name}</span>
                <span className="explore__target">{rest.join('  ')}</span>
                {entry.status === 'error' ? <ErrorIcon className="explore__error" /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** 一轮结束时的改动汇总卡片。 */
function ChangesCard({ item }: { item: Of<'changes'> }) {
  const t = useT();
  const total = item.files.reduce(
    (sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
  return (
    <section className="changes" aria-label={t('changes.label')}>
      <header className="changes__header">
        <DiffIcon />
        <span>{t('changes.title', item.total)}</span>
        <Stats stats={total} />
      </header>
      <ul className="changes__list">
        {item.files.map((file) => (
          <li key={`${file.path}:${JSON.stringify(file.ref)}`}>
            <ChangedFileButton file={file} className="changes__file" />
          </li>
        ))}
      </ul>
      {item.source === 'tools' ? <p className="changes__note">{t('changes.toolsOnly')}</p> : null}
      {item.total > item.files.length ? <p className="changes__note">{t('changes.more', item.total - item.files.length)}</p> : null}
    </section>
  );
}

/** 改动的文件：文件名在前、目录淡显，点击打开 Diff，打开期间显示加载中。 */
export function ChangedFileButton({ file, className }: { file: ChangedFileView; className: string }) {
  const t = useT();
  const opening = useDiffOpening(file.ref);
  const slash = file.path.lastIndexOf('/');
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const dir = slash >= 0 ? file.path.slice(0, slash) : '';
  return (
    <button type="button" className={className} onClick={() => openDiff(file.ref)} title={t('edit.view', file.path)} aria-busy={opening}>
      <span className="changes__icon">{opening ? <SpinnerIcon /> : <FileIcon />}</span>
      <span className="changes__path">
        <span className="changes__name">{name}</span>
        {dir ? <span className="changes__dir">{dir}</span> : null}
      </span>
      {file.created ? <span className="changes__flag">{t('changes.created')}</span> : null}
      {file.flags?.includes('binary') ? <span className="changes__flag">{t('changes.binary')}</span> : null}
      {file.flags?.includes('oversized') ? <span className="changes__flag">{t('changes.oversized')}</span> : null}
      <Stats stats={file} />
    </button>
  );
}

/** 增删行数（导出给会话改动栏）。 */
export { Stats };

function Notice({ item }: { item: Of<'notice'> }) {
  return (
    <div className={`notice notice--${item.level}`} role={item.level === 'error' ? 'alert' : undefined}>
      {item.level === 'info' ? <InfoIcon /> : <ErrorIcon />}
      <span>
        {item.text}
        {item.action ? (
          <>
            {' '}
            <button type="button" className="link-button" onClick={() => postToHost({ type: item.action?.kind ?? 'openWebUI', payload: {} })}>
              {item.action.kind === 'configureApiKey' ? <KeyIcon /> : <GlobeIcon />}
              {item.action.label}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}
