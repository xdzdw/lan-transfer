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

  it("scrolls the conversation container to the newest item", () => {
    const scrollTo = vi.fn();
    const container = { scrollHeight: 640, scrollTo } as unknown as HTMLDivElement;

    scrollConversationToLatest(container);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 640,
      behavior: "smooth",
    });
  });
});
