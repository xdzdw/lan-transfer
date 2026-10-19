import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_MAX_FILE_BYTES,
  FILE_CHUNK_BYTES,
  FILE_HEADER_BYTES,
  RELAY_MAX_FILE_BYTES,
  RelayLimitError,
  getRelayRestrictedSize,
  isRelayExemptImage,
  isRelayFileAllowed,
} from "../shared/relayLimits";

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "report.pdf",
  size: 10,
  mimeType: "application/pdf",
  totalChunks: 1,
};

describe("shared relay limits", () => {
  it("exports the confirmed 10 MiB relay default and binary framing constants", () => {
    expect(DEFAULT_RELAY_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(RELAY_MAX_FILE_BYTES).toBe(DEFAULT_RELAY_MAX_FILE_BYTES);
    expect(FILE_CHUNK_BYTES).toBe(64_000);
    expect(FILE_HEADER_BYTES).toBe(40);
  });

  it("limits ordinary files and uses the folder aggregate for restricted folder transfers", () => {
    expect(isRelayFileAllowed({ ...base, size: RELAY_MAX_FILE_BYTES })).toBe(
      true
    );
    expect(
      isRelayFileAllowed({ ...base, size: RELAY_MAX_FILE_BYTES + 1 })
    ).toBe(false);
    expect(
      getRelayRestrictedSize({
        ...base,
        size: 1,
        folderId: "folder-1",
        folderRestrictedSize: RELAY_MAX_FILE_BYTES + 1,
      })
    ).toBe(RELAY_MAX_FILE_BYTES + 1);
    expect(
      getRelayRestrictedSize({
        ...base,
        size: 1,
        folderId: "folder-1",
        folderTotalSize: 42,
      })
    ).toBe(42);
  });

  it("exempts actual image-shaped metadata but never a screenshot flag alone", () => {
    const image = {
      ...base,
      name: "capture.png",
      mimeType: "image/png",
      size: RELAY_MAX_FILE_BYTES + 1,
    };
    expect(isRelayExemptImage(image)).toBe(true);
    expect(isRelayFileAllowed(image)).toBe(true);
    expect(isRelayExemptImage({ ...base, isScreenshot: true })).toBe(false);
    expect(
      isRelayExemptImage({ ...base, isScreenshot: true, name: "capture.png" })
    ).toBe(false);
    expect(
      isRelayExemptImage({ ...base, name: "photo.heic", mimeType: "" })
    ).toBe(true);
    expect(
      isRelayExemptImage({
        ...base,
        name: "capture.png",
        mimeType: "application/octet-stream",
      })
    ).toBe(false);
  });

  it("carries the stable limit error fields", () => {
    const error = new RelayLimitError(123, base.id);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("RELAY_FILE_TOO_LARGE");
    expect(error.maxBytes).toBe(123);
    expect(error.fileId).toBe(base.id);
  });
});
