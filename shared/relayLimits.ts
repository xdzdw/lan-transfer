/**
 * Shared relay-fallback limits. Direct WebRTC transfers are intentionally not
 * governed by these values.
 */
export const DEFAULT_RELAY_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const RELAY_MAX_FILE_BYTES = DEFAULT_RELAY_MAX_FILE_BYTES;

/** Binary relay frame layout: 36-byte UUID followed by a 4-byte chunk index. */
export const FILE_CHUNK_BYTES = 64_000;
export const FILE_HEADER_BYTES = 40;

/**
 * Metadata describes a transfer, never its contents. `folderRestrictedSize` is
 * the aggregate size of non-image files in a folder when supplied by current
 * clients; `folderTotalSize` is retained for compatibility with older clients.
 */
export interface RelayFileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  isScreenshot?: boolean;
  folderId?: string;
  folderRestrictedSize?: number;
  folderTotalSize?: number;
  totalChunks?: number;
  folderName?: string;
  relativePath?: string;
  folderFileCount?: number;
}

const IMAGE_MIME_TYPE = /^image\/[a-z0-9.+-]+$/i;
const IMAGE_FILE_NAME =
  /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

/**
 * A screenshot flag alone is never enough to exempt a file. Normal image
 * uploads require both an image MIME type and an image-looking filename.
 * Browsers occasionally omit MIME types for drag-and-drop HEIC/TIFF files, so
 * an empty MIME value may fall back to an image filename extension. Generic
 * MIME types such as application/octet-stream never receive that fallback.
 */
export function isRelayExemptImage(
  meta: Pick<RelayFileMeta, "name" | "mimeType" | "isScreenshot">
): boolean {
  const imageMime =
    typeof meta.mimeType === "string" && IMAGE_MIME_TYPE.test(meta.mimeType);
  const imageName =
    typeof meta.name === "string" && IMAGE_FILE_NAME.test(meta.name);
  const emptyMime =
    typeof meta.mimeType === "string" && meta.mimeType.trim() === "";
  return imageName && (imageMime || emptyMime);
}

/**
 * Return the amount that participates in the relay quota. Images do not use
 * the ordinary-file quota. Folder transfers use their declared aggregate of
 * restricted files when available, then the legacy total, then this file size.
 */
export function getRelayRestrictedSize(meta: RelayFileMeta): number {
  if (isRelayExemptImage(meta)) return 0;

  const folderSize = meta.folderId
    ? (meta.folderRestrictedSize ?? meta.folderTotalSize)
    : undefined;
  if (
    typeof folderSize === "number" &&
    Number.isFinite(folderSize) &&
    folderSize >= 0
  ) {
    // A malformed/forged aggregate must not make a larger member look small.
    return Math.max(meta.size, folderSize);
  }
  return meta.size;
}

export function isRelayFileAllowed(
  meta: RelayFileMeta,
  maxBytes: number = RELAY_MAX_FILE_BYTES
): boolean {
  return getRelayRestrictedSize(meta) <= maxBytes;
}

export class RelayLimitError extends Error {
  readonly code = "RELAY_FILE_TOO_LARGE" as const;
  readonly maxBytes: number;
  readonly fileId?: string;

  constructor(maxBytes: number = RELAY_MAX_FILE_BYTES, fileId?: string) {
    super(`File exceeds the relay limit of ${maxBytes} bytes`);
    this.name = "RelayLimitError";
    this.maxBytes = maxBytes;
    this.fileId = fileId;
  }
}
