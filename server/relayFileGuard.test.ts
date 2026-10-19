import { describe, expect, it } from "vitest";
import {
  FILE_CHUNK_BYTES,
  RELAY_MAX_FILE_BYTES,
  type RelayFileMeta,
} from "../shared/relayLimits";
import {
  RELAY_METADATA_TTL_MS,
  RelayFileGuard,
  parseRelayChunkFrame,
} from "./relayFileGuard";

const id = "00000000-0000-4000-8000-000000000001";
const meta = (overrides: Partial<RelayFileMeta> = {}): RelayFileMeta => ({
  id,
  name: "document.pdf",
  size: 100,
  mimeType: "application/pdf",
  totalChunks: 1,
  ...overrides,
});

function pngChunk(length = FILE_CHUNK_BYTES): Buffer {
  const payload = Buffer.alloc(length);
  payload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return payload;
}

describe("RelayFileGuard", () => {
  it("registers a too-large P2P candidate without a proactive rejection, then rejects relay chunks", () => {
    const guard = new RelayFileGuard();
    const large = meta({
      size: RELAY_MAX_FILE_BYTES + 1,
      totalChunks: Math.ceil((RELAY_MAX_FILE_BYTES + 1) / FILE_CHUNK_BYTES),
    });
    expect(guard.register(large).ok).toBe(true);
    const decision = guard.acceptChunk(id, 0, Buffer.alloc(FILE_CHUNK_BYTES));
    expect(decision).toMatchObject({
      ok: false,
      code: "RELAY_FILE_TOO_LARGE",
      fileId: id,
    });
  });

  it("uses declared and observed restricted folder totals without double-counting duplicate registrations", () => {
    const guard = new RelayFileGuard();
    const restricted = meta({
      folderId: "folder",
      folderRestrictedSize: RELAY_MAX_FILE_BYTES + 1,
    });
    expect(guard.allowLegacyMeta(restricted)).toMatchObject({
      ok: false,
      code: "RELAY_FILE_TOO_LARGE",
    });

    const folderGuard = new RelayFileGuard(100);
    const first = meta({
      id,
      size: 60,
      totalChunks: 1,
      folderId: "folder",
      folderRestrictedSize: 60,
    });
    const second = meta({
      id: "00000000-0000-4000-8000-000000000002",
      size: 60,
      totalChunks: 1,
      folderId: "folder",
      folderRestrictedSize: 60,
    });
    expect(folderGuard.register(first).ok).toBe(true);
    expect(folderGuard.register(first).ok).toBe(true);
    expect(folderGuard.register(second).ok).toBe(true);
    expect(folderGuard.allowControl(id)).toMatchObject({
      ok: false,
      code: "RELAY_FILE_TOO_LARGE",
    });
  });

  it("retains relay eligibility for a normal folder containing more than 128 small files", () => {
    const guard = new RelayFileGuard();
    for (let index = 0; index < 130; index++) {
      const fileId = `00000000-0000-4000-8000-${(100 + index).toString().padStart(12, "0")}`;
      expect(
        guard.register(
          meta({
            id: fileId,
            size: 1,
            totalChunks: 1,
            folderId: "large-folder",
            folderRestrictedSize: 130,
          })
        ).ok
      ).toBe(true);
    }
    expect(guard.size).toBe(130);
  });

  it("allows a large real-PNG-shaped image without requiring fallback to start at index zero", () => {
    const guard = new RelayFileGuard();
    const imageId = "00000000-0000-4000-8000-000000000002";
    const size = RELAY_MAX_FILE_BYTES + 1;
    const image = meta({
      id: imageId,
      name: "photo.png",
      mimeType: "image/png",
      size,
      totalChunks: Math.ceil(size / FILE_CHUNK_BYTES),
    });
    expect(guard.register(image)).toMatchObject({ ok: true });
    // A P2P-to-relay fallback can begin from a later missing chunk.
    expect(guard.acceptChunk(imageId, 1, pngChunk())).toMatchObject({
      ok: true,
    });
  });

  it("rejects invalid metadata, unknown chunks, wrong lengths, and unlimited normal retries", () => {
    const guard = new RelayFileGuard();
    expect(guard.register({ ...meta(), totalChunks: 2 })).toMatchObject({
      ok: false,
      code: "RELAY_FILE_INVALID",
    });
    expect(guard.acceptChunk(id, 0, Buffer.alloc(1))).toMatchObject({
      ok: false,
      code: "RELAY_FILE_INVALID",
    });

    expect(guard.register(meta()).ok).toBe(true);
    expect(guard.acceptChunk(id, 0, Buffer.alloc(99))).toMatchObject({
      ok: false,
      code: "RELAY_FILE_INVALID",
    });

    const retryId = "00000000-0000-4000-8000-000000000003";
    const retries = new RelayFileGuard();
    expect(retries.register(meta({ id: retryId })).ok).toBe(true);
    for (let count = 0; count < 8; count++) {
      expect(retries.acceptChunk(retryId, 0, Buffer.alloc(100)).ok).toBe(true);
    }
    expect(retries.acceptChunk(retryId, 0, Buffer.alloc(100))).toMatchObject({
      ok: false,
      code: "RELAY_FILE_INVALID",
    });
  });

  it("keeps valid metadata for 120 seconds, refreshes identical registration, and clears expired state", () => {
    const guard = new RelayFileGuard();
    const now = 1_000;
    expect(guard.register(meta(), now).ok).toBe(true);
    expect(guard.has(id, now)).toBe(true);
    expect(guard.register(meta(), now + RELAY_METADATA_TTL_MS - 1).ok).toBe(
      true
    );
    guard.cleanup(now + RELAY_METADATA_TTL_MS + 1);
    expect(guard.has(id, now + RELAY_METADATA_TTL_MS + 1)).toBe(true);
    guard.cleanup(now + RELAY_METADATA_TTL_MS * 2 + 1);
    expect(guard.has(id, now + RELAY_METADATA_TTL_MS * 2 + 1)).toBe(false);
  });

  it("parses only UUID/index framed binary chunks", () => {
    const frame = Buffer.alloc(40 + 3);
    frame.write(id, 0, "utf8");
    frame.writeUInt32BE(7, 36);
    frame.set([1, 2, 3], 40);
    expect(parseRelayChunkFrame(frame)).toMatchObject({
      fileId: id,
      index: 7,
      payload: Buffer.from([1, 2, 3]),
    });
    expect(parseRelayChunkFrame(Buffer.from("too short"))).toBeNull();
  });
});
