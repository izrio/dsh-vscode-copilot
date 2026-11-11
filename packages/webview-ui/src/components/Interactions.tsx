/**
 * 等待用户处理的请求，显示在对话流末尾：审批（dsh 要越过沙箱执行命令或修改文件）和提问（ask_user_question）。
 * 回答后由 Host 回传给 dsh，卡片随 Host 推送的列表消失。
 */
import { useEffect, useRef, useState } from 'react';
import type { PendingInteraction, QuestionView } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { Markdown } from './Markdown.tsx';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
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
  const [sent, setSent] = useState<'allow' | 'allowAlways' | 'reject' | undefined>();
  const t = useT();
  const blocked = item.dirtyFiles.length > 0;
  const isDsh = useView((s) => (s.backends.items.find((b) => b.id === s.backends.active)?.kind ?? 'dsh') === 'dsh');
  const respond = (decision: 'allow' | 'allowAlways' | 'reject') => {
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
      {item.reason && item.reason !== item.subject ? <p className="interaction__reason">{item.reason}</p> : null}
      {/* 「越过沙箱、只对这一次生效」是 dsh 的审批语义，其他底层不显示 */}
      {isDsh ? <p className="interaction__hint">{t('approval.hint')}</p> : null}
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
        {item.allowAlways ? (
          <button type="button" className="button button--secondary" disabled={sent !== undefined || blocked} title={t('approval.allowAlwaysTitle')} onClick={() => respond('allowAlways')}>
            {sent === 'allowAlways' ? <SpinnerIcon /> : null}
            {item.allowAlways}
          </button>
        ) : null}
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

/** 单选时选中后自动进入下一题的延迟：让选中状态先显示出来。 */
const ADVANCE_DELAY_MS = 220;

/**
 * 提问卡片。多个问题时逐题回答：顶部是进度（第几题、每题一个可点击的步骤点），底部「上一题 / 下一题」，
 * 最后一题才「提交」，一次把所有回答交给 dsh。单选题选中后自动进入下一题。
 */
function QuestionCard({ item }: { item: Of<'question'> }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [step, setStep] = useState(0);
  const [sent, setSent] = useState<'submit' | 'skip' | undefined>();
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  const questions = item.questions;
  const total = questions.length;
  const index = Math.min(step, total - 1);
  const q = questions[index]!;
  const last = index === total - 1;
  const draftOf = (question: QuestionView): Draft => drafts[question.id] ?? { selected: [], custom: '' };
  const answered = (question: QuestionView) => draftOf(question).selected.length > 0 || draftOf(question).custom.trim().length > 0;
  const complete = questions.every(answered);
  const draft = draftOf(q);

  const goTo = (next: number) => {
    clearTimeout(advanceTimer.current);
    setStep(Math.max(0, Math.min(total - 1, next)));
  };

  const submit = () => {
    if (!complete || sent) {
      // 还有没回答的题：跳到第一道
      const missing = questions.findIndex((question) => !answered(question));
      if (missing >= 0) goTo(missing);
      return;
    }
    setSent('submit');
    postToHost({
      type: 'answerQuestion',
      payload: {
        id: item.id,
        answers: questions.map((question) => {
          const d = draftOf(question);
          const custom = d.custom.trim();
          return { id: question.id, selected: [...d.selected], ...(custom ? { custom } : {}) };
        }),
      },
    });
  };
  const skip = () => {
    setSent('skip');
    postToHost({ type: 'answerQuestion', payload: { id: item.id, cancelled: true } });
  };
  const next = () => (last ? submit() : answered(q) ? goTo(index + 1) : undefined);

  const toggle = (label: string) => {
    const has = draft.selected.includes(label);
    const selected = q.multiSelect ? (has ? draft.selected.filter((l) => l !== label) : [...draft.selected, label]) : has ? [] : [label];
    setDrafts({ ...drafts, [q.id]: { ...draft, selected } });
    if (!q.multiSelect && !has && !last) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => setStep(index + 1), ADVANCE_DELAY_MS);
    }
  };

  /** 步骤点的提示：问题和已选的回答。 */
  const summary = (question: QuestionView) => {
    const d = draftOf(question);
    const answer = [...d.selected, d.custom.trim()].filter(Boolean).join(t('question.separator'));
    return answer ? `${question.header ?? question.question}：${answer}` : (question.header ?? question.question);
  };

  return (
    <section className="interaction interaction--question" aria-label={t('question.label')} data-testid="question-card">
      <header className="interaction__header question-card__header">
        <span className="question-card__icon">
          <QuestionIcon />
        </span>
        <span className="question-card__title">{t('question.title')}</span>
        {total > 1 ? (
          <span className="question-card__count" data-testid="question-step">
            {t('question.step', index + 1, total)}
          </span>
        ) : null}
      </header>
      {total > 1 ? (
        <div className="question-steps" role="tablist" aria-label={t('question.steps')}>
          {questions.map((question, i) => (
            <button
              key={question.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={t('question.goTo', i + 1)}
              title={summary(question)}
              className={`question-steps__dot ${i === index ? 'question-steps__dot--current' : ''} ${answered(question) ? 'question-steps__dot--done' : ''}`}
              disabled={sent !== undefined}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      ) : null}
      <fieldset key={q.id} className="question" disabled={sent !== undefined}>
        <legend className="question__title">
          {q.header ? <span className="question__header">{q.header}</span> : null}
          <span className="question__text">{q.question}</span>
        </legend>
        {q.detail ? <p className="question__detail">{q.detail}</p> : null}
        {q.multiSelect ? <p className="question__mode">{t('question.multi')}</p> : null}
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
                  <span className={`question__mark ${q.multiSelect ? 'question__mark--box' : ''}`} aria-hidden>
                    {active ? <CheckIcon /> : null}
                  </span>
                  <span className="question__body">
                    <span className="question__label">{option.label}</span>
                    {option.description ? <span className="question__description">{option.description}</span> : null}
                  </span>
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
          autoFocus={index > 0 && q.options.length === 0}
          onChange={(event) => setDrafts({ ...drafts, [q.id]: { ...draft, custom: event.target.value } })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) next();
          }}
        />
      </fieldset>
      <div className="interaction__actions question-card__actions">
        <button type="button" className="link-button question-card__skip" disabled={sent !== undefined} onClick={skip}>
          {sent === 'skip' ? <SpinnerIcon /> : <FastForwardIcon />}
          {total > 1 ? t('question.skipAll') : t('question.skip')}
        </button>
        <span className="question-card__spacer" />
        {total > 1 && index > 0 ? (
          <button type="button" className="button button--secondary" disabled={sent !== undefined} onClick={() => goTo(index - 1)}>
            <ArrowLeftIcon />
            {t('question.prev')}
          </button>
        ) : null}
        {last ? (
          <button type="button" className="button" disabled={!complete || sent !== undefined} onClick={submit}>
            {sent === 'submit' ? <SpinnerIcon /> : <SendIcon />}
            {t('question.submit')}
          </button>
        ) : (
          <button type="button" className="button" disabled={!answered(q) || sent !== undefined} onClick={next}>
            {t('question.next')}
            <ArrowRightIcon />
          </button>
        )}
      </div>
    </section>
  );
}
