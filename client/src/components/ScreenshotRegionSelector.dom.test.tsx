// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenshotRegionSelector } from "./ScreenshotRegionSelector";

vi.mock("@/contexts/I18nContext", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("ScreenshotRegionSelector DOM interaction", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test-screenshot"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("enables and preserves confirmation after bottom-right pointer release", () => {
    const file = new File(["fake-png"], "screenshot.png", {
      type: "image/png",
    });
    render(
      <ScreenshotRegionSelector
        file={file}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const image = screen.getByRole("img");
    Object.defineProperty(image, "clientWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(image, "clientHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 600,
    });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });

    const surface = image.parentElement!;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    surface.releasePointerCapture = vi.fn();

    const confirmButton = screen.getByRole("button", {
      name: "useSelectedRegion",
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 40, clientY: 30 });
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: 260,
      clientY: 190,
    });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 360, clientY: 270 });

    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.pointerMove(surface, {
      pointerId: 1,
      clientX: 399,
      clientY: 299,
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    expect(surface.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("sends the original full screenshot without requiring a region", () => {
    const file = new File(["full-screen"], "screenshot.png", {
      type: "image/png",
    });
    const onConfirm = vi.fn();
    render(
      <ScreenshotRegionSelector
        file={file}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "sendFullScreenshot" }));

    expect(onConfirm).toHaveBeenCalledWith(file);
  });
});
