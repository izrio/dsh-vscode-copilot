/** 对话流里的各类条目。遵循 docs/DESIGN.md 3.1：没有角色标签，工具调用压成一行，没有内容就不渲染。 */
import { memo, useState } from 'react';
import type { Item } from '@dsh-copilot/shared';
import { postToHost } from '../vscode.ts';
import { Markdown } from './Markdown.tsx';
import { ChevronRightIcon, ErrorIcon, InfoIcon, SpinnerIcon, ToolIcon } from './icons.tsx';

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>;

export const ItemView = memo(function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'assistant':
      return <AssistantMessage item={item} />;
    case 'activity':
      return <ActivityRow item={item} />;
    case 'notice':
      return <Notice item={item} />;
  }
});

function UserBubble({ item }: { item: Of<'user'> }) {
  return (
    <div className={`user ${item.pending ? `user--${item.pending}` : ''}`}>
      <div className="user__bubble">{item.text}</div>
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

function ActivityRow({ item }: { item: Of<'activity'> }) {
  const [open, setOpen] = useState(false);
  const [name, ...rest] = item.label.split('  ');
  const detail = rest.join('  ');
  const expandable = Boolean(item.output);
  return (
    <div className={`activity activity--${item.status}`}>
      <button
        type="button"
        className="activity__row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(!open)}
        title={item.label}
      >
        <span className="activity__icon">
          {item.status === 'running' ? <SpinnerIcon /> : item.status === 'error' ? <ErrorIcon /> : <ToolIcon />}
        </span>
        <span className="activity__name">{name}</span>
        {detail ? <span className="activity__detail">{detail}</span> : null}
      </button>
      {open && item.output ? <pre className="activity__output">{item.output}</pre> : null}
    </div>
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
