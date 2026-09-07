import { describe, expect, it } from "vitest";
import {
  ScreenshotCaptureError,
  isImageClipboardSupported,
  isScreenshotCaptureSupported,
} from "./screenshot";

describe("screenshot capture support", () => {
  it("reports unsupported when screen capture APIs are unavailable", () => {
    expect(isScreenshotCaptureSupported()).toBe(false);
  });

  it("reports image clipboard support conservatively", () => {
    expect(isImageClipboardSupported()).toBe(false);
  });

  it("keeps capture errors classified for the UI", () => {
    const error = new ScreenshotCaptureError("cancelled", "cancelled");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ScreenshotCaptureError");
    expect(error.code).toBe("cancelled");
  });
});
