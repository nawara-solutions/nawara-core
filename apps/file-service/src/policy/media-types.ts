/**
 * The V1 media-type allow-list (ADR-0048, SDD §7, decision F13). A caller policy may narrow it, never widen it. The TYPE of an uploaded
 * file will be decided from its bytes in Stage 17.5; this list only bounds what any caller may ever be allowed.
 */
export const FILE_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export type FileMediaType = (typeof FILE_MEDIA_TYPES)[number];
