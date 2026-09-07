import { describe, expect, it } from "vitest";
import { isValidScreenshotSelection, normalizeSelection } from "./ScreenshotRegionSelector";

describe("ScreenshotRegionSelector", () => {
  it("normalizes a drag in any direction into a positive rectangle", () => {
    expect(normalizeSelection({ x: 240, y: 180 }, { x: 40, y: 20 })).toEqual({
      left: 40,
      top: 20,
      width: 200,
      height: 160,
    });
  });

  it("returns no selection before the user drags", () => {
    expect(normalizeSelection(null, null)).toBeNull();
  });

  it("keeps confirm disabled until the selection reaches the minimum size", () => {
    expect(isValidScreenshotSelection(null)).toBe(false);
    expect(isValidScreenshotSelection({ width: 7, height: 30 })).toBe(false);
    expect(isValidScreenshotSelection({ width: 8, height: 8 })).toBe(true);
  });
});
