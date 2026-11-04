/**
 * 等待用户处理的请求，显示在对话流末尾：审批（dsh 要越过沙箱执行命令或修改文件）和提问（ask_user_question）。
 * 回答后由 Host 回传给 dsh，卡片随 Host 推送的列表消失。
 */
import { useState } from 'react';
import type { PendingInteraction, QuestionView } from '@dsh-copilot/shared';
import { postToHost } from '../vscode.ts';
import { EyeIcon, QuestionIcon, ShieldIcon } from './icons.tsx';

type Of<K extends PendingInteraction['kind']> = Extract<PendingInteraction, { kind: K }>;

export function InteractionCard({ interaction }: { interaction: PendingInteraction }) {
  return interaction.kind === 'approval' ? <ApprovalCard item={interaction} /> : <QuestionCard item={interaction} />;
}

function ApprovalCard({ item }: { item: Of<'approval'> }) {
  const [sent, setSent] = useState(false);
  const blocked = item.dirtyFiles.length > 0;
  const respond = (decision: 'allow' | 'reject') => {
    setSent(true);
    postToHost({ type: 'respondApproval', payload: { id: item.id, decision } });
  };
  const title = item.subjectKind === 'command' ? 'dsh 想运行这条命令' : item.subjectKind === 'file' ? 'dsh 想修改这个文件' : `dsh 想使用 ${item.toolName}`;
  return (
    <section className="interaction interaction--approval" aria-label="需要你的确认" data-testid="approval-card">
      <header className="interaction__header">
        <ShieldIcon />
        <span>{title}</span>
      </header>
      {item.subjectKind === 'command' && item.subject ? <pre className="interaction__command">{item.subject}</pre> : null}
      {item.subjectKind === 'file' && item.subject ? (
        <button type="button" className="link-button interaction__file" onClick={() => postToHost({ type: 'openFile', payload: { path: item.subject ?? '' } })}>
          {item.subject}
        </button>
      ) : null}
      {item.reason ? <p className="interaction__reason">{item.reason}</p> : null}
      <p className="interaction__hint">这一步需要越过工作区沙箱，只对这一次生效。</p>
      {blocked ? (
        <div className="interaction__warning" role="alert">
          <span>{item.dirtyFiles.join('、')} 有未保存的修改，先保存再允许，避免和编辑器里的内容冲突。</span>
          <button type="button" className="link-button" onClick={() => postToHost({ type: 'saveAll', payload: {} })}>
            全部保存
          </button>
        </div>
      ) : null}
      <div className="interaction__actions">
        <button type="button" className="button" disabled={sent || blocked} onClick={() => respond('allow')}>
          允许本次
        </button>
        <button type="button" className="button button--secondary" disabled={sent} onClick={() => respond('reject')}>
          拒绝
        </button>
        {item.previewable ? (
          <button type="button" className="toolbar-button interaction__preview" onClick={() => postToHost({ type: 'previewApproval', payload: { id: item.id } })}>
            <EyeIcon />
            <span>预览修改</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

interface Draft {
  readonly selected: readonly string[];
  readonly custom: string;
}

function QuestionCard({ item }: { item: Of<'question'> }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sent, setSent] = useState(false);
  const draftOf = (q: QuestionView): Draft => drafts[q.id] ?? { selected: [], custom: '' };
  const update = (q: QuestionView, next: Draft) => setDrafts({ ...drafts, [q.id]: next });
  const answered = (q: QuestionView) => draftOf(q).selected.length > 0 || draftOf(q).custom.trim().length > 0;
  const complete = item.questions.every(answered);

  const submit = () => {
    if (!complete || sent) return;
    setSent(true);
    postToHost({
      type: 'answerQuestion',
      payload: {
        id: item.id,
        answers: item.questions.map((q) => {
          const draft = draftOf(q);
          const custom = draft.custom.trim();
          return { id: q.id, selected: [...draft.selected], ...(custom ? { custom } : {}) };
        }),
      },
    });
  };
  const skip = () => {
    setSent(true);
    postToHost({ type: 'answerQuestion', payload: { id: item.id, cancelled: true } });
  };

  return (
    <section className="interaction interaction--question" aria-label="dsh 的提问" data-testid="question-card">
      <header className="interaction__header">
        <QuestionIcon />
        <span>dsh 想先确认一下</span>
      </header>
      {item.questions.map((q) => {
        const draft = draftOf(q);
        const toggle = (label: string) => {
          const has = draft.selected.includes(label);
          const selected = q.multiSelect ? (has ? draft.selected.filter((l) => l !== label) : [...draft.selected, label]) : has ? [] : [label];
          update(q, { ...draft, selected });
        };
        return (
          <fieldset key={q.id} className="question" disabled={sent}>
            <legend className="question__title">
              {q.header ? <span className="question__header">{q.header}</span> : null}
              {q.question}
            </legend>
            {q.detail ? <p className="question__detail">{q.detail}</p> : null}
            {q.options.length > 0 ? (
              <div className="question__options" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((option) => {
                  const active = draft.selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={active}
                      className={`question__option ${active ? 'question__option--active' : ''}`}
                      onClick={() => toggle(option.label)}
                    >
                      <span className="question__label">{option.label}</span>
                      {option.description ? <span className="question__description">{option.description}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <input
              className="question__custom"
              value={draft.custom}
              placeholder={q.options.length > 0 ? '其他（可选）' : '输入回答'}
              aria-label={`${q.question} 的回答`}
              onChange={(event) => update(q, { ...draft, custom: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
              }}
            />
          </fieldset>
        );
      })}
      <div className="interaction__actions">
        <button type="button" className="button" disabled={!complete || sent} onClick={submit}>
          提交
        </button>
        <button type="button" className="button button--secondary" disabled={sent} onClick={skip}>
          跳过
        </button>
        {item.questions.some((q) => q.multiSelect) ? <span className="interaction__hint">可多选</span> : null}
      </div>
    </section>
  );
}
