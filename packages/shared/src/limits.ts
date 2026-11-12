/**
 * 不依赖 zod 的常量，Webview 直接从 `@harness-deck/shared/limits` 引入。
 * 从包入口引入会把 bridge.ts 的 zod 模式一起打进 Webview，zod 启动时探测 `new Function` 会触发 CSP 违规。
 */

/** dsh 接受的图片格式。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** 一条消息最多带的图片数，和单张图片 base64 的上限（约 15 MB 原始字节；dsh 自己还有更严格的限制）。 */
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BASE64 = 20_000_000;
