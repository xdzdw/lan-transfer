// @vitest-environment jsdom

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@/components/LangSwitch", () => ({
  LangSwitch: () => null,
}));

vi.mock("@/contexts/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        captureScreenshot: "Capture screenshot",
        attachFile: "Attach file",
        typeMessage: "Type a message or paste files...",
        attachFolder: "Attach folder",
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
        onSendFolder: vi.fn(),
        onDisconnect: vi.fn(),
        role: "host",
        transportMode: "relay",
      })
    );

    expect(markup).toContain('aria-label="Capture screenshot"');
    expect(markup).toContain('aria-label="Attach file"');
    expect(markup).toContain('aria-label="Attach folder"');
  });

  it("sends a file pasted into the message editor", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const onSendFile = vi.fn();
    const file = new File(["pasted"], "pasted.txt", { type: "text/plain" });
    const clipboardItem = {
      kind: "file",
      type: file.type,
      getAsFile: () => file,
      getAsString: () => undefined,
      webkitGetAsEntry: () => null,
    } as unknown as DataTransferItem;
    const view = render(
      React.createElement(TransferPanel, {
        items: [],
        onSendText: vi.fn(),
        onSendFile,
        onSendFolder: vi.fn(),
        onDisconnect: vi.fn(),
        role: "host",
        transportMode: "relay",
      })
    );

    const textarea = view.container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    fireEvent.paste(textarea!, { clipboardData: { items: [clipboardItem] } });

    await waitFor(() => expect(onSendFile).toHaveBeenCalledWith(file));
    view.unmount();
  });
});
