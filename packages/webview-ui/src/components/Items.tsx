/** 对话流里的各类条目。遵循 docs/DESIGN.md 3.1：没有角色标签，工具调用压成一行，没有内容就不渲染。 */
import { memo, useState, type ReactNode } from 'react';
import type { DiffRef, Item, LineStats } from '@dsh-copilot/shared';
import { splitMentions } from '../mentions.ts';
import { postToHost } from '../vscode.ts';
import { attachmentLabel, openAttachment } from './ContextChips.tsx';
import { Markdown } from './Markdown.tsx';
import { ChevronRightIcon, ErrorIcon, FileEditIcon, FileIcon, InfoIcon, SearchIcon, SelectionIcon, SpinnerIcon, TerminalIcon, ToolIcon } from './icons.tsx';

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>;

export const ItemView = memo(function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'assistant':
      return <AssistantMessage item={item} />;
    case 'activity':
      return item.variant === 'edit' ? <EditRow item={item} /> : <ActivityRow item={item} />;
    case 'explore':
      return <ExploreRow item={item} />;
    case 'changes':
      return <ChangesCard item={item} />;
    case 'notice':
      return <Notice item={item} />;
  }
});

function UserBubble({ item }: { item: Of<'user'> }) {
  return (
    <div className={`user ${item.pending ? `user--${item.pending}` : ''}`}>
      {item.text ? (
        <div className="user__bubble">
          <UserText text={item.text} />
        </div>
      ) : null}
      {item.attachments?.length ? (
        <div className="user__attachments">
          {item.attachments.map((a) => (
            <button key={attachmentLabel(a) + a.path} type="button" className="chip chip--small" onClick={() => openAttachment(a)} title={`打开 ${a.path}`}>
              {a.kind === 'selection' ? <SelectionIcon /> : <FileIcon />}
              <span className="chip__label">{attachmentLabel(a)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {item.pending === 'queued' ? <div className="user__meta">排队中，当前回复结束后发送</div> : null}
      {item.pending === 'failed' ? (
        <div className="user__meta user__meta--error">
          <span>发送失败{item.error ? `：${item.error}` : ''}</span>
          <button type="button" className="link-button" onClick={() => item.requestId && postToHost({ type: 'retryPending', payload: { requestId: item.requestId } })}>
            重试
          </button>
          <button type="button" className="link-button" onClick={() => item.requestId && postToHost({ type: 'discardPending', payload: { requestId: item.requestId } })}>
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 用户消息正文：`@路径` 显示成可点击的引用。 */
function UserText({ text }: { text: string }) {
  return (
    <>
      {splitMentions(text).map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <button key={index} type="button" className="mention" onClick={() => postToHost({ type: 'openFile', payload: { path: part.path } })} title={`打开 ${part.path}`}>
            {part.text}
          </button>
        ),
      )}
    </>
  );
}

function AssistantMessage({ item }: { item: Of<'assistant'> }) {
  return (
    <div className="assistant">
      {item.reasoning ? <Reasoning text={item.reasoning} active={item.streaming && !item.markdown} /> : null}
      {item.markdown ? <Markdown text={item.markdown} /> : null}
      {item.streaming && item.markdown ? <span className="cursor" aria-hidden /> : null}
    </div>
  );
}

/** 推理过程：进行中只显示一行"思考中"，结束后折叠成一行，点开查看。 */
function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button type="button" className="reasoning__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRightIcon className={`chevron ${open ? 'chevron--open' : ''}`} />
        <span className={active ? 'shimmer' : undefined}>{active ? '思考中…' : '思考过程'}</span>
      </button>
      {open ? <div className="reasoning__body">{text}</div> : null}
    </div>
  );
}

const openDiff = (ref: DiffRef) => postToHost({ type: 'openDiff', payload: { ref } });

function StatusIcon({ status, icon }: { status: 'running' | 'ok' | 'error'; icon: ReactNode }) {
  return <span className="activity__icon">{status === 'running' ? <SpinnerIcon /> : status === 'error' ? <ErrorIcon /> : icon}</span>;
}

/** 命令和其他工具：一行摘要，点开看输出。 */
function ActivityRow({ item }: { item: Of<'activity'> }) {
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
        <StatusIcon status={item.status} icon={command ? <TerminalIcon /> : <ToolIcon />} />
        {command ? (
          <span className="activity__name">{item.status === 'running' ? '正在运行' : '已运行'}</span>
        ) : (
          <span className="activity__name">{name}</span>
        )}
        {(command ? detail || name : detail) ? <span className="activity__detail">{command ? detail || name : detail}</span> : null}
      </button>
      {open && item.output ? <pre className="activity__output">{item.output}</pre> : null}
    </div>
  );
}

/** 文件修改：「已编辑 src/a.ts +3 −1」，点击打开 Diff。 */
function EditRow({ item }: { item: Of<'activity'> }) {
  const [open, setOpen] = useState(false);
  const verb = item.status === 'running' ? '正在编辑' : item.status === 'error' ? '编辑失败' : item.created ? '已新建' : '已编辑';
  const diff = item.diff;
  const onClick = () => (diff ? openDiff(diff) : item.output ? setOpen(!open) : undefined);
  return (
    <div className={`activity activity--${item.status} activity--edit`}>
      <button
        type="button"
        className="activity__row"
        disabled={!diff && !item.output}
        aria-expanded={!diff && item.output ? open : undefined}
        onClick={onClick}
        title={diff ? `查看 ${item.label} 的修改` : item.label}
      >
        <StatusIcon status={item.status} icon={<FileEditIcon />} />
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
  const [open, setOpen] = useState(false);
  return (
    <div className={`activity activity--${item.status}`}>
      <button type="button" className="activity__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StatusIcon status={item.status} icon={<SearchIcon />} />
        <span className="activity__name">{item.status === 'running' ? '正在浏览' : '已浏览'}</span>
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
  const total = item.files.reduce(
    (sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
  return (
    <section className="changes" aria-label="本轮改动">
      <header className="changes__header">
        <span>{item.total} 个文件已更改</span>
        <Stats stats={total} />
      </header>
      <ul className="changes__list">
        {item.files.map((file) => (
          <li key={`${file.path}:${JSON.stringify(file.ref)}`}>
            <button type="button" className="changes__file" onClick={() => openDiff(file.ref)} title={`查看 ${file.path} 的修改`}>
              <span className="changes__path">{file.path}</span>
              {file.created ? <span className="changes__flag">新建</span> : null}
              {file.flags?.includes('binary') ? <span className="changes__flag">二进制</span> : null}
              {file.flags?.includes('oversized') ? <span className="changes__flag">过大</span> : null}
              <Stats stats={file} />
            </button>
          </li>
        ))}
      </ul>
      {item.source === 'tools' ? <p className="changes__note">dsh 重启过，这里只列出文件工具的修改，命令造成的改动不在其中。</p> : null}
      {item.total > item.files.length ? <p className="changes__note">还有 {item.total - item.files.length} 个文件未列出。</p> : null}
    </section>
  );
}

function Notice({ item }: { item: Of<'notice'> }) {
  return (
    <div className={`notice notice--${item.level}`} role={item.level === 'error' ? 'alert' : undefined}>
      {item.level === 'info' ? <InfoIcon /> : <ErrorIcon />}
      <span>
        {item.text}
        {item.action ? (
          <>
            {' '}
            <button type="button" className="link-button" onClick={() => postToHost({ type: 'openWebUI', payload: {} })}>
              {item.action.label}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}
