/**
 * 消息里的图片：输入框里待发送的缩略图、消息气泡里的缩略图，以及点击后的大图查看。
 * 图片内容不放进视图模型：本地图片按 localId、dsh 保存的图片按 attachmentId 缓存在 store 里，按需向 Host 读取。
 */
import { useEffect, useState } from 'react';
import type { ImageView } from '@harness-deck/shared';
import { imageKey, requestImage, useView } from '../store.ts';
import { CloseIcon, ErrorIcon, ImageIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

/** 图片的 data URL；还没读到时为 undefined，读取失败时为 'error'。 */
export function useImageSrc(image: ImageView): string | 'error' | undefined {
  const key = imageKey(image);
  const value = useView((s) => (key ? s.images[key] : undefined));
  useEffect(() => {
    if (image.attachmentId && value === undefined) requestImage(image.attachmentId);
  }, [image.attachmentId, value]);
  return value === 'loading' ? undefined : value;
}

/** 一张缩略图；点击放大。 */
export function ImageThumb({ image, onRemove, size = 'normal' }: { image: ImageView; onRemove?: () => void; size?: 'normal' | 'small' }) {
  const t = useT();
  const src = useImageSrc(image);
  const [open, setOpen] = useState(false);
  const label = image.name ?? t('image.label');
  return (
    <span className={`image-thumb image-thumb--${size}`}>
      <button type="button" className="image-thumb__button" onClick={() => src && src !== 'error' && setOpen(true)} title={label} aria-label={t('image.view', label)}>
        {src === 'error' ? (
          <span className="image-thumb__placeholder" title={t('image.failed')}>
            <ErrorIcon />
          </span>
        ) : src ? (
          <img src={src} alt={label} />
        ) : (
          <span className="image-thumb__placeholder image-thumb__placeholder--loading">
            <ImageIcon />
          </span>
        )}
      </button>
      {onRemove ? (
        <button type="button" className="image-thumb__remove" onClick={onRemove} aria-label={t('image.remove', label)} title={t('image.remove', label)}>
          <CloseIcon />
        </button>
      ) : null}
      {open && src && src !== 'error' ? <Lightbox src={src} label={label} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

/** 大图：铺满面板，点击任意处或按 Esc 关闭。 */
function Lightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={label} onClick={onClose}>
      <img src={src} alt={label} />
      <button type="button" className="icon-button lightbox__close" aria-label={t('common.close')} onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );
}
