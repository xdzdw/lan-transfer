import {
  FILE_CHUNK_BYTES,
  FILE_HEADER_BYTES,
  RELAY_MAX_FILE_BYTES,
  getRelayRestrictedSize,
  isRelayExemptImage,
  isRelayFileAllowed,
  type RelayFileMeta,
} from "../shared/relayLimits";

export const RELAY_METADATA_TTL_MS = 120_000;
/** Bounded enough for normal large folders while still TTL-cleaned in memory. */
export const MAX_RELAY_FILES_PER_DIRECTION = 2_048;

const MAX_STRING_LENGTH = 1_024;
const MAX_NORMAL_CHUNK_ATTEMPTS = 8;
const NORMAL_RETRY_MULTIPLIER = 8;
const UUID_LENGTH = 36;
const UINT32_MAX = 0xffff_ffff;

export type RelayRejectCode = "RELAY_FILE_TOO_LARGE" | "RELAY_FILE_INVALID";

export interface RelayGuardDecision {
  ok: boolean;
  code?: RelayRejectCode;
  fileId?: string;
  maxBytes: number;
}

interface RelayEntry {
  meta: RelayFileMeta;
  restrictedSize: number;
  imageExempt: boolean;
  relayAllowed: boolean;
  createdAt: number;
  expiresAt: number;
  rejected: boolean;
  rejectionCode?: RelayRejectCode;
  /** Counts and lengths only; file content is never persisted. */
  chunks: Map<number, { attempts: number; length: number }>;
  uniqueBytes: number;
  forwardedBytes: number;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function validOptionalSize(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNonNegativeInteger(value);
}

function validOptionalString(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= MAX_STRING_LENGTH)
  );
}

function cloneMeta(input: RelayFileMeta): RelayFileMeta {
  return {
    id: input.id,
    name: input.name,
    size: input.size,
    mimeType: input.mimeType,
    isScreenshot: input.isScreenshot,
    folderId: input.folderId,
    folderRestrictedSize: input.folderRestrictedSize,
    folderTotalSize: input.folderTotalSize,
    totalChunks: input.totalChunks,
    folderName: input.folderName,
    relativePath: input.relativePath,
    folderFileCount: input.folderFileCount,
  };
}

function sameMeta(a: RelayFileMeta, b: RelayFileMeta): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.size === b.size &&
    a.mimeType === b.mimeType &&
    a.isScreenshot === b.isScreenshot &&
    a.folderId === b.folderId &&
    a.folderRestrictedSize === b.folderRestrictedSize &&
    a.folderTotalSize === b.folderTotalSize &&
    a.totalChunks === b.totalChunks &&
    a.folderName === b.folderName &&
    a.relativePath === b.relativePath &&
    a.folderFileCount === b.folderFileCount
  );
}

/** Runtime validation keeps untrusted websocket JSON out of the relay state. */
export function isValidRelayFileMeta(value: unknown): value is RelayFileMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<RelayFileMeta>;
  if (
    typeof meta.id !== "string" ||
    meta.id.length === 0 ||
    meta.id.length > MAX_STRING_LENGTH ||
    typeof meta.name !== "string" ||
    meta.name.length > MAX_STRING_LENGTH ||
    !isFiniteNonNegativeInteger(meta.size) ||
    typeof meta.mimeType !== "string" ||
    meta.mimeType.length > 255 ||
    (meta.isScreenshot !== undefined &&
      typeof meta.isScreenshot !== "boolean") ||
    !validOptionalString(meta.folderId) ||
    !validOptionalString(meta.folderName) ||
    !validOptionalString(meta.relativePath) ||
    !validOptionalSize(meta.folderRestrictedSize) ||
    !validOptionalSize(meta.folderTotalSize) ||
    !validOptionalSize(meta.folderFileCount) ||
    !isFiniteNonNegativeInteger(meta.totalChunks) ||
    meta.totalChunks > UINT32_MAX
  ) {
    return false;
  }

  const expectedChunks = Math.ceil(meta.size / FILE_CHUNK_BYTES);
  // A zero-byte file has no binary chunks; every other frame has a uint32 index.
  return meta.totalChunks === expectedChunks;
}

function invalid(maxBytes: number, fileId?: string): RelayGuardDecision {
  return { ok: false, code: "RELAY_FILE_INVALID", fileId, maxBytes };
}

/**
 * Per-room, per-sending-direction in-memory guard. It retains only metadata,
 * counters, indexes and timestamps, never filenames in logs or file contents.
 */
export class RelayFileGuard {
  private readonly entries = new Map<string, RelayEntry>();
  /** Bounded cancellation tombstones also handle a cancel arriving before meta. */
  private readonly cancelledIds = new Map<string, number>();

  constructor(
    readonly maxBytes: number = RELAY_MAX_FILE_BYTES,
    readonly ttlMs: number = RELAY_METADATA_TTL_MS,
    readonly maxEntries: number = MAX_RELAY_FILES_PER_DIRECTION
  ) {}

  get size(): number {
    this.cleanup();
    return this.entries.size;
  }

  cleanup(now = Date.now()): void {
    for (const [id, entry] of Array.from(this.entries.entries())) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    for (const [id, expiresAt] of Array.from(this.cancelledIds.entries())) {
      if (expiresAt <= now) this.cancelledIds.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
    this.cancelledIds.clear();
  }

  /**
   * Folder declarations are client supplied, so also sum each distinct,
   * registered ordinary member. This map is bounded by `maxEntries` and is
   * recalculated rather than retaining any file content or paths.
   */
  private getFolderRestrictedBytes(folderId: string): number {
    let total = 0;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.meta.folderId === folderId && !entry.imageExempt)
        total += entry.meta.size;
    }
    return total;
  }

  private refreshFolderAllowance(folderId: string): void {
    const folderBytes = this.getFolderRestrictedBytes(folderId);
    for (const entry of Array.from(this.entries.values())) {
      if (entry.meta.folderId === folderId) {
        entry.relayAllowed =
          isRelayFileAllowed(entry.meta, this.maxBytes) &&
          (entry.imageExempt || folderBytes <= this.maxBytes);
      }
    }
  }

  /** Register metadata. Oversize ordinary files are retained for P2P fallback but not relay-eligible. */
  register(input: unknown, now = Date.now()): RelayGuardDecision {
    this.cleanup(now);
    if (!isValidRelayFileMeta(input)) return invalid(this.maxBytes);
    const meta = cloneMeta(input);
    if (this.cancelledIds.has(meta.id)) return invalid(this.maxBytes, meta.id);
    const existing = this.entries.get(meta.id);
    if (existing) {
      if (!sameMeta(existing.meta, meta))
        return this.reject(meta.id, "RELAY_FILE_INVALID", now);
      existing.expiresAt = now + this.ttlMs;
      if (meta.folderId) this.refreshFolderAllowance(meta.folderId);
      return existing.rejected
        ? {
            ok: false,
            code: existing.rejectionCode ?? "RELAY_FILE_INVALID",
            fileId: meta.id,
            maxBytes: this.maxBytes,
          }
        : { ok: true, fileId: meta.id, maxBytes: this.maxBytes };
    }

    if (this.entries.size >= this.maxEntries)
      return invalid(this.maxBytes, meta.id);
    const imageExempt = isRelayExemptImage(meta);
    const restrictedSize = getRelayRestrictedSize(meta);
    this.entries.set(meta.id, {
      meta,
      restrictedSize,
      imageExempt,
      relayAllowed: isRelayFileAllowed(meta, this.maxBytes),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      rejected: false,
      chunks: new Map(),
      uniqueBytes: 0,
      forwardedBytes: 0,
    });
    if (meta.folderId) this.refreshFolderAllowance(meta.folderId);
    return { ok: true, fileId: meta.id, maxBytes: this.maxBytes };
  }

  /** A legacy file-meta must itself be valid and relay-eligible to be forwarded. */
  allowLegacyMeta(input: unknown, now = Date.now()): RelayGuardDecision {
    const registered = this.register(input, now);
    if (!registered.ok) return registered;
    const entry = this.entries.get(registered.fileId!);
    if (!entry || !entry.relayAllowed) {
      return this.reject(registered.fileId!, "RELAY_FILE_TOO_LARGE", now);
    }
    return registered;
  }

  /** Validate and count a chunk. The caller has already read its id and index from the 40-byte header. */
  acceptChunk(
    fileId: string,
    index: number,
    payload: Buffer,
    now = Date.now()
  ): RelayGuardDecision {
    this.cleanup(now);
    const entry = this.entries.get(fileId);
    if (!entry) return invalid(this.maxBytes, fileId);
    entry.expiresAt = now + this.ttlMs;
    if (entry.rejected) {
      return {
        ok: false,
        code: entry.rejectionCode ?? "RELAY_FILE_INVALID",
        fileId,
        maxBytes: this.maxBytes,
      };
    }
    if (!entry.relayAllowed)
      return this.reject(fileId, "RELAY_FILE_TOO_LARGE", now);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= entry.meta.totalChunks!
    ) {
      return this.reject(fileId, "RELAY_FILE_INVALID", now);
    }

    const expectedLength =
      index === entry.meta.totalChunks! - 1
        ? entry.meta.size - index * FILE_CHUNK_BYTES
        : FILE_CHUNK_BYTES;
    if (payload.length !== expectedLength)
      return this.reject(fileId, "RELAY_FILE_INVALID", now);

    const previous = entry.chunks.get(index);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (!entry.imageExempt) {
      const retryBudget =
        Math.max(entry.meta.size, FILE_CHUNK_BYTES) * NORMAL_RETRY_MULTIPLIER;
      if (
        attempts > MAX_NORMAL_CHUNK_ATTEMPTS ||
        entry.forwardedBytes + payload.length > retryBudget
      ) {
        return this.reject(fileId, "RELAY_FILE_INVALID", now);
      }
    }

    if (!previous) {
      const uniqueBytes = entry.uniqueBytes + payload.length;
      if (uniqueBytes > entry.meta.size)
        return this.reject(fileId, "RELAY_FILE_INVALID", now);
      entry.uniqueBytes = uniqueBytes;
    }
    entry.chunks.set(index, { attempts, length: payload.length });
    entry.forwardedBytes += payload.length;
    return { ok: true, fileId, maxBytes: this.maxBytes };
  }

  /** Used for file-complete, ack and chunk-request control validation. */
  allowControl(fileId: unknown, now = Date.now()): RelayGuardDecision {
    this.cleanup(now);
    if (typeof fileId !== "string" || !fileId) return invalid(this.maxBytes);
    const entry = this.entries.get(fileId);
    if (!entry) return invalid(this.maxBytes, fileId);
    entry.expiresAt = now + this.ttlMs;
    if (entry.rejected) {
      return {
        ok: false,
        code: entry.rejectionCode ?? "RELAY_FILE_INVALID",
        fileId,
        maxBytes: this.maxBytes,
      };
    }
    if (!entry.relayAllowed)
      return this.reject(fileId, "RELAY_FILE_TOO_LARGE", now);
    return { ok: true, fileId, maxBytes: this.maxBytes };
  }

  reject(
    fileId: string,
    code: RelayRejectCode = "RELAY_FILE_INVALID",
    now = Date.now()
  ): RelayGuardDecision {
    const entry = this.entries.get(fileId);
    if (entry) {
      entry.rejected = true;
      entry.rejectionCode = code;
      entry.expiresAt = now + this.ttlMs;
    }
    return { ok: false, code, fileId, maxBytes: this.maxBytes };
  }

  /** Mark cancellation even when the original sender has just reconnected. */
  cancel(fileId: unknown, now = Date.now()): RelayGuardDecision {
    if (typeof fileId !== "string" || !fileId) return invalid(this.maxBytes);
    const entry = this.entries.get(fileId);
    if (entry) return this.reject(fileId, "RELAY_FILE_INVALID", now);
    if (this.cancelledIds.size >= this.maxEntries) {
      const oldest = this.cancelledIds.keys().next().value as
        | string
        | undefined;
      if (oldest) this.cancelledIds.delete(oldest);
    }
    this.cancelledIds.set(fileId, now + this.ttlMs);
    return { ok: true, fileId, maxBytes: this.maxBytes };
  }

  has(fileId: unknown, now = Date.now()): boolean {
    this.cleanup(now);
    return typeof fileId === "string" && this.entries.has(fileId);
  }
}

/** The binary frame parser deliberately returns no payload copy. */
export function parseRelayChunkFrame(
  buffer: Buffer
): { fileId: string; index: number; payload: Buffer } | null {
  if (buffer.length < FILE_HEADER_BYTES) return null;
  const fileId = buffer.subarray(0, UUID_LENGTH).toString("utf8");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      fileId
    )
  ) {
    return null;
  }
  return {
    fileId,
    index: buffer.readUInt32BE(UUID_LENGTH),
    payload: buffer.subarray(FILE_HEADER_BYTES),
  };
}
