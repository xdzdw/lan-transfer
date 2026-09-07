import { describe, expect, it } from "vitest";
import {
  ScreenshotCaptureError,
  isImageClipboardSupported,
  isScreenshotCaptureSupported,
  scaleCropSelection,
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
    expect(error.name).toBe("ScreenshotCaptureError");
    expect(error.code).toBe("cancelled");
  });

  it("classifies black selected-window frames separately", () => {
    const error = new ScreenshotCaptureError("black", "black frame");
    expect(error.code).toBe("black");
  });

  it("maps a displayed selection back to natural screenshot pixels", () => {
    expect(scaleCropSelection(
      { x: 10, y: 20, width: 100, height: 50 },
      { width: 500, height: 250 },
      { width: 1000, height: 500 },
    )).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });
});
