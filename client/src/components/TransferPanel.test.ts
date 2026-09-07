import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/LangSwitch", () => ({
  LangSwitch: () => null,
}));

vi.mock("@/contexts/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        captureScreenshot: "Capture screenshot",
        attachFile: "Attach file",
        typeMessage: "Type a message...",
        connected: "Connected",
        end: "End",
        readyToTransfer: "Ready to transfer",
        dragFilesHere: "Drag files here or type below",
        upgrading: "Upgrading",
        relay: "Relay",
        reconnectingHint: "Connection lost. Reconnecting automatically...",
      })[key] ?? key,
  }),
}));

import { TransferPanel } from "./TransferPanel";

describe("TransferPanel screenshot control", () => {
  it("renders a labeled screenshot capture button beside file attachment", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TransferPanel, {
        items: [],
        onSendText: vi.fn(),
        onSendFile: vi.fn(),
        onDisconnect: vi.fn(),
        role: "host",
        transportMode: "relay",
      })
    );

    expect(markup).toContain('aria-label="Capture screenshot"');
    expect(markup).toContain('aria-label="Attach file"');
  });
});
