import { describe, expect, it } from "vitest";
import { emptyScreenshotSelection, isValidScreenshotSelection, normalizeSelection, reduceScreenshotSelection } from "./ScreenshotRegionSelector";

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

  it("uses the final bottom-right pointer coordinate and ends the drag state on release", () => {
    const started = reduceScreenshotSelection(emptyScreenshotSelection, { type: "down", point: { x: 20, y: 20 } });
    const moved = reduceScreenshotSelection(started, { type: "move", point: { x: 280, y: 180 } });
    const finished = reduceScreenshotSelection(moved, { type: "up", point: { x: 320, y: 240 } });

    expect(finished.isDragging).toBe(false);
    expect(normalizeSelection(finished.start, finished.current)).toEqual({
      left: 20,
      top: 20,
      width: 300,
      height: 220,
    });

    const afterReleaseMove = reduceScreenshotSelection(finished, { type: "move", point: { x: 500, y: 500 } });
    expect(afterReleaseMove).toEqual(finished);
  });

  it("keeps confirm disabled until the selection reaches the minimum size", () => {
    expect(isValidScreenshotSelection(null)).toBe(false);
    expect(isValidScreenshotSelection({ width: 7, height: 30 })).toBe(false);
    expect(isValidScreenshotSelection({ width: 8, height: 8 })).toBe(true);
  });
});
