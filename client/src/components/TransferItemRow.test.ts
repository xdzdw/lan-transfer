import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        copyToClipboard: "Copy to clipboard",
        copiedToClipboard: "Copied to clipboard",
      })[key] ?? key,
  }),
}));

import { TransferItemRow } from "./TransferItemRow";
import { scrollConversationToLatest } from "./TransferPanel";
import type { TransferItem } from "@/hooks/usePeerHost";

const textItem = {
  id: "message-1",
  type: "text",
  content: "A new message arrives",
  timestamp: Date.now(),
  direction: "received",
  status: "done",
} as TransferItem;

const screenshotItem = {
  id: "screenshot-1",
  type: "file",
  direction: "received",
  name: "screenshot-2026.png",
  size: 1024,
  timestamp: Date.now(),
  status: "transferring",
  progress: 42,
  isScreenshot: true,
} as TransferItem;

const completedScreenshotItem = {
  id: "screenshot-done",
  type: "file",
  direction: "received",
  name: "screenshot-done.png",
  size: 2048,
  blob: new Blob(["png"], { type: "image/png" }),
  previewUrl: "data:image/png;base64,cG5n",
  timestamp: Date.now(),
  status: "done",
  isScreenshot: true,
} as TransferItem;

describe("conversation message layout", () => {
  it("keeps the copy action in the message footer at the right", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TransferItemRow, { item: textItem })
    );

    const footerIndex = markup.indexOf(
      "mt-1.5 flex items-center justify-between gap-2"
    );
    const copyButtonIndex = markup.indexOf('title="Copy to clipboard"');

    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(copyButtonIndex).toBeGreaterThan(footerIndex);
    expect(markup).toContain("A new message arrives");
  });

  it("renders screenshot messages with a progress state", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TransferItemRow, { item: screenshotItem })
    );

    expect(markup).toContain("screenshot");
    expect(markup).toContain("42%");
  });

  it("renders a completed received screenshot with preview and save action", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TransferItemRow, { item: completedScreenshotItem })
    );

    expect(markup).toContain('alt="screenshotAlt"');
    expect(markup).toContain('src="data:image/png;base64,cG5n"');
    expect(markup).toContain("copyScreenshot");
    expect(markup).toContain("saveScreenshot");
  });

  it("renders a folder summary with its file count and save action", () => {
    const folder = {
      id: "folder-1",
      type: "folder",
      direction: "received",
      name: "Photos",
      folderFileCount: 2,
      folderTotalSize: 12,
      timestamp: Date.now(),
      status: "done",
    } as TransferItem;
    const children = [
      {
        ...textItem,
        id: "file-1",
        type: "file",
        name: "one.txt",
        folderId: "folder-1",
        blob: new Blob(["one"]),
        status: "done",
      },
      {
        ...textItem,
        id: "file-2",
        type: "file",
        name: "two.txt",
        folderId: "folder-1",
        blob: new Blob(["two"]),
        status: "done",
      },
    ] as unknown as TransferItem[];
    const markup = renderToStaticMarkup(
      React.createElement(TransferItemRow, {
        item: folder,
        allItems: [folder, ...children],
      })
    );

    expect(markup).toContain("Photos");
    expect(markup).toContain("2 folderFiles");
    expect(markup).toContain("saveFolder");
  });

  it("scrolls the conversation container to the newest item", () => {
    const scrollTo = vi.fn();
    const container = {
      scrollHeight: 640,
      scrollTo,
    } as unknown as HTMLDivElement;

    scrollConversationToLatest(container);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 640,
      behavior: "smooth",
    });
  });
});
