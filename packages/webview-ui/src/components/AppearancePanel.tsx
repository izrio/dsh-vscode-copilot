/**
 * 字体与字号：直接在面板里调整，写入 VS Code 设置 harnessDeck.ui.fontSize / fontFamily / codeFontFamily。
 * 改动先在本地生效（不等设置写完），留空或「恢复默认」时跟随 VS Code。
 */
import { useState } from 'react';
import type { AppearanceState } from '@harness-deck/shared';
import { setAppearanceLocal, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { useT } from '../i18n.ts';

const MIN_SIZE = 10;
const MAX_SIZE = 24;

type Patch = { fontSize?: number | null; fontFamily?: string | null; codeFontFamily?: string | null; palette?: 'theme' | null };

function apply(current: AppearanceState, patch: Patch): void {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  setAppearanceLocal(next as AppearanceState);
  postToHost({ type: 'setAppearance', payload: patch });
}

/** 当前生效的字号：设置了就是设置值，否则读页面的实际字号（VS Code 字号 + 1）。 */
function effectiveSize(appearance: AppearanceState): number {
  if (appearance.fontSize) return appearance.fontSize;
  const size = Number.parseFloat(getComputedStyle(document.body).fontSize);
  return Number.isFinite(size) ? Math.round(size) : 14;
}

export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const appearance = useView((s) => s.appearance);
  const size = effectiveSize(appearance);
  const [family, setFamily] = useState(appearance.fontFamily ?? '');
  const [codeFamily, setCodeFamily] = useState(appearance.codeFontFamily ?? '');

  const setSize = (value: number) => apply(appearance, { fontSize: Math.min(MAX_SIZE, Math.max(MIN_SIZE, value)) });
  const commitFamily = (key: 'fontFamily' | 'codeFontFamily', value: string) => {
    const trimmed = value.trim();
    if (trimmed === (appearance[key] ?? '')) return;
    apply(appearance, { [key]: trimmed || null });
  };
  const reset = () => {
    setFamily('');
    setCodeFamily('');
    apply(appearance, { fontSize: null, fontFamily: null, codeFontFamily: null, palette: null });
  };

  return (
    <div className="appearance" data-testid="appearance-panel">
      <div className="appearance__title">{t('header.appearance')}</div>
      <div className="appearance__row">
        <span className="appearance__label">{t('appearance.size')}</span>
        <div className="stepper">
          <button type="button" className="stepper__button" aria-label={t('appearance.smaller')} disabled={size <= MIN_SIZE} onClick={() => setSize(size - 1)}>
            −
          </button>
          <span className="stepper__value" data-testid="appearance-size">
            {size}px
          </span>
          <button type="button" className="stepper__button" aria-label={t('appearance.larger')} disabled={size >= MAX_SIZE} onClick={() => setSize(size + 1)}>
            +
          </button>
        </div>
        {appearance.fontSize ? null : <span className="appearance__default">{t('appearance.default')}</span>}
      </div>
      <label className="appearance__field">
        <span className="appearance__label">{t('appearance.family')}</span>
        <input
          className="appearance__input"
          value={family}
          placeholder={t('appearance.familyPlaceholder')}
          onChange={(event) => setFamily(event.target.value)}
          onBlur={() => commitFamily('fontFamily', family)}
          onKeyDown={(event) => event.key === 'Enter' && commitFamily('fontFamily', family)}
        />
      </label>
      <label className="appearance__field">
        <span className="appearance__label">{t('appearance.codeFamily')}</span>
        <input
          className="appearance__input"
          value={codeFamily}
          placeholder={t('appearance.codeFamilyPlaceholder')}
          onChange={(event) => setCodeFamily(event.target.value)}
          onBlur={() => commitFamily('codeFontFamily', codeFamily)}
          onKeyDown={(event) => event.key === 'Enter' && commitFamily('codeFontFamily', codeFamily)}
        />
      </label>
      <label className="appearance__row appearance__switch">
        <span className="appearance__label">{t('appearance.soft')}</span>
        <input
          type="checkbox"
          role="switch"
          data-testid="appearance-soft"
          checked={appearance.palette !== 'theme'}
          onChange={(event) => apply(appearance, { palette: event.target.checked ? null : 'theme' })}
        />
        <span className="appearance__hint">{t('appearance.softHint')}</span>
      </label>
      <div className="appearance__actions">
        <button type="button" className="link-button" onClick={reset}>
          {t('appearance.reset')}
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            onClose();
            postToHost({ type: 'openSettings', payload: {} });
          }}
        >
          {t('appearance.allSettings')}
        </button>
      </div>
    </div>
  );
}
