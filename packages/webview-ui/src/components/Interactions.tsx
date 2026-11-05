/**
 * 等待用户处理的请求，显示在对话流末尾：审批（dsh 要越过沙箱执行命令或修改文件）和提问（ask_user_question）。
 * 回答后由 Host 回传给 dsh，卡片随 Host 推送的列表消失。
 */
import { useState } from 'react';
import type { PendingInteraction, QuestionView } from '@dsh-copilot/shared';
import { postToHost } from '../vscode.ts';
import { Markdown } from './Markdown.tsx';
import {
  ChatIcon,
  CheckIcon,
  CloseIcon,
  EyeIcon,
  FastForwardIcon,
  PencilIcon,
  PlanIcon,
  QuestionIcon,
  ReplyIcon,
  SaveIcon,
  SendIcon,
  ShieldIcon,
  SpinnerIcon,
} from './icons.tsx';
import { useT } from '../i18n.ts';

type Of<K extends PendingInteraction['kind']> = Extract<PendingInteraction, { kind: K }>;

export function InteractionCard({ interaction }: { interaction: PendingInteraction }) {
  if (interaction.kind === 'approval') return <ApprovalCard item={interaction} />;
  const review = interaction.questions.length === 1 ? interaction.questions[0] : undefined;
  if (review?.intent?.kind === 'plan-review') return <PlanReviewCard id={interaction.id} question={review} />;
  return <QuestionCard item={interaction} />;
}

function ApprovalCard({ item }: { item: Of<'approval'> }) {
  const [sent, setSent] = useState<'allow' | 'reject' | undefined>();
  const t = useT();
  const blocked = item.dirtyFiles.length > 0;
  const respond = (decision: 'allow' | 'reject') => {
    setSent(decision);
    postToHost({ type: 'respondApproval', payload: { id: item.id, decision } });
  };
  const title = item.subjectKind === 'command' ? t('approval.command') : item.subjectKind === 'file' ? t('approval.file') : t('approval.tool', item.toolName);
  return (
    <section className="interaction interaction--approval" aria-label={t('approval.label')} data-testid="approval-card">
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
      <p className="interaction__hint">{t('approval.hint')}</p>
      {blocked ? (
        <div className="interaction__warning" role="alert">
          <span>{t('approval.dirty', item.dirtyFiles.join(', '))}</span>
          <button type="button" className="link-button" onClick={() => postToHost({ type: 'saveAll', payload: {} })}>
            <SaveIcon />
            {t('dirty.saveAll')}
          </button>
        </div>
      ) : null}
      <div className="interaction__actions">
        <button type="button" className="button" disabled={sent !== undefined || blocked} onClick={() => respond('allow')}>
          {sent === 'allow' ? <SpinnerIcon /> : <CheckIcon />}
          {t('approval.allow')}
        </button>
        <button type="button" className="button button--secondary" disabled={sent !== undefined} onClick={() => respond('reject')}>
          {sent === 'reject' ? <SpinnerIcon /> : <CloseIcon />}
          {t('approval.reject')}
        </button>
        {item.previewable ? (
          <button type="button" className="toolbar-button interaction__preview" onClick={() => postToHost({ type: 'previewApproval', payload: { id: item.id } })}>
            <EyeIcon />
            <span>{t('approval.preview')}</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** 计划审阅：显示 dsh 提交的计划，批准后退出计划模式开始执行，或者写反馈让它继续完善。 */
function PlanReviewCard({ id, question }: { id: string; question: QuestionView }) {
  const t = useT();
  const [feedback, setFeedback] = useState<string | undefined>();
  const [sent, setSent] = useState<'approve' | 'keep' | 'reply' | undefined>();
  const intent = question.intent!;
  const answer = (selected: string, custom?: string) => {
    setSent(selected === intent.approve ? 'approve' : 'keep');
    postToHost({ type: 'answerQuestion', payload: { id, answers: [{ id: question.id, selected: [selected], ...(custom ? { custom } : {}) }] } });
  };
  const keep = intent.keepPlanning ?? question.options.find((o) => o.label !== intent.approve)?.label ?? 'Keep planning';
  return (
    <section className="interaction interaction--plan" aria-label={t('plan.label')} data-testid="plan-review-card">
      <header className="interaction__header">
        <PlanIcon />
        <span>{t('plan.title')}</span>
      </header>
      {question.detail ? (
        <div className="interaction__plan">
          <Markdown text={question.detail} />
        </div>
      ) : null}
      {feedback !== undefined ? (
        <textarea
          className="question__custom interaction__feedback"
          rows={3}
          autoFocus
          value={feedback}
          placeholder={t('plan.feedbackPlaceholder')}
          aria-label={t('plan.feedbackLabel')}
          disabled={sent !== undefined}
          onChange={(event) => setFeedback(event.target.value)}
        />
      ) : null}
      <div className="interaction__actions">
        {feedback === undefined ? (
          <>
            <button type="button" className="button" disabled={sent !== undefined} onClick={() => answer(intent.approve)}>
              {sent === 'approve' ? <SpinnerIcon /> : <CheckIcon />}
              {t('plan.approve')}
            </button>
            <button type="button" className="button button--secondary" disabled={sent !== undefined} onClick={() => setFeedback('')}>
              <PencilIcon />
              {t('plan.keep')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button" disabled={sent !== undefined} onClick={() => answer(keep, feedback.trim() || undefined)}>
              {sent === 'keep' ? <SpinnerIcon /> : <SendIcon />}
              {t('plan.sendFeedback')}
            </button>
            <button type="button" className="button button--secondary" disabled={sent !== undefined} onClick={() => setFeedback(undefined)}>
              <ReplyIcon />
              {t('plan.back')}
            </button>
          </>
        )}
        <button
          type="button"
          className="link-button interaction__skip"
          disabled={sent !== undefined}
          title={t('plan.replyTitle')}
          onClick={() => {
            setSent('reply');
            postToHost({ type: 'answerQuestion', payload: { id, cancelled: true } });
          }}
        >
          {sent === 'reply' ? <SpinnerIcon /> : <ChatIcon />}
          {t('plan.reply')}
        </button>
      </div>
    </section>
  );
}

interface Draft {
  readonly selected: readonly string[];
  readonly custom: string;
}

function QuestionCard({ item }: { item: Of<'question'> }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sent, setSent] = useState<'submit' | 'skip' | undefined>();
  const draftOf = (q: QuestionView): Draft => drafts[q.id] ?? { selected: [], custom: '' };
  const update = (q: QuestionView, next: Draft) => setDrafts({ ...drafts, [q.id]: next });
  const answered = (q: QuestionView) => draftOf(q).selected.length > 0 || draftOf(q).custom.trim().length > 0;
  const complete = item.questions.every(answered);

  const submit = () => {
    if (!complete || sent) return;
    setSent('submit');
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
    setSent('skip');
    postToHost({ type: 'answerQuestion', payload: { id: item.id, cancelled: true } });
  };

  return (
    <section className="interaction interaction--question" aria-label={t('question.label')} data-testid="question-card">
      <header className="interaction__header">
        <QuestionIcon />
        <span>{t('question.title')}</span>
      </header>
      {item.questions.map((q) => {
        const draft = draftOf(q);
        const toggle = (label: string) => {
          const has = draft.selected.includes(label);
          const selected = q.multiSelect ? (has ? draft.selected.filter((l) => l !== label) : [...draft.selected, label]) : has ? [] : [label];
          update(q, { ...draft, selected });
        };
        return (
          <fieldset key={q.id} className="question" disabled={sent !== undefined}>
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
              placeholder={q.options.length > 0 ? t('question.other') : t('question.answer')}
              aria-label={t('question.answerLabel', q.question)}
              onChange={(event) => update(q, { ...draft, custom: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
              }}
            />
          </fieldset>
        );
      })}
      <div className="interaction__actions">
        <button type="button" className="button" disabled={!complete || sent !== undefined} onClick={submit}>
          {sent === 'submit' ? <SpinnerIcon /> : <SendIcon />}
          {t('question.submit')}
        </button>
        <button type="button" className="button button--secondary" disabled={sent !== undefined} onClick={skip}>
          {sent === 'skip' ? <SpinnerIcon /> : <FastForwardIcon />}
          {t('question.skip')}
        </button>
        {item.questions.some((q) => q.multiSelect) ? <span className="interaction__hint">{t('question.multi')}</span> : null}
      </div>
    </section>
  );
}
