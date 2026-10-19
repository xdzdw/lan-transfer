// @vitest-environment jsdom

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

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
        turnRelay: "TURN Relay",
        relayFileSizeHint: "Relay files up to {limit}; images exempt",
        relayFileTooLarge: "Relay transfer limited to {limit}",
        reconnectingHint: "Connection lost. Reconnecting automatically...",
      })[key] ?? key,
  }),
}));

import { isVisibleConversationItem, TransferPanel } from "./TransferPanel";
import type { TransferItem } from "@/hooks/usePeerHost";
import { RelayLimitError } from "@shared/relayLimits";
import { toast } from "sonner";

describe("TransferPanel screenshot control", () => {
  it("shows a folder as one conversation message and hides its child files", () => {
    const folder = {
      id: "folder-1",
      type: "folder",
      direction: "received",
      name: "Project",
      status: "transferring",
      timestamp: Date.now(),
    } as TransferItem;
    const child = {
      id: "file-1",
      type: "file",
      direction: "received",
      name: "secret-child-name.txt",
      folderId: "folder-1",
      status: "transferring",
      timestamp: Date.now(),
    } as TransferItem;

    expect(isVisibleConversationItem(folder)).toBe(true);
    expect(isVisibleConversationItem(child)).toBe(false);

    const markup = renderToStaticMarkup(
      React.createElement(TransferPanel, {
        items: [folder, child],
        onSendText: vi.fn(),
        onSendFile: vi.fn(),
        onSendFolder: vi.fn(),
        onDisconnect: vi.fn(),
        role: "client",
        transportMode: "relay",
      })
    );
    expect(markup).toContain("Project");
    expect(markup).not.toContain("secret-child-name.txt");
  });

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

  it("falls back to clipboardData.files when an item cannot expose its file", async () => {
    const onSendFile = vi.fn();
    const file = new File(["clipboard-file"], "clipboard-file.txt", {
      type: "text/plain",
    });
    const unavailableItem = {
      kind: "file",
      type: file.type,
      getAsFile: () => null,
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
    fireEvent.paste(textarea!, {
      clipboardData: { items: [unavailableItem], files: [file] },
    });

    await waitFor(() => expect(onSendFile).toHaveBeenCalledWith(file));
    view.unmount();
  });

  it("sends a dropped file when the browser exposes only dataTransfer.files", async () => {
    const onSendFile = vi.fn();
    const file = new File(["dropped-file"], "dropped-file.txt", {
      type: "text/plain",
    });
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

    const panel = view.container.firstElementChild as HTMLElement;
    fireEvent.drop(panel, {
      dataTransfer: { items: [], files: [file], types: ["Files"] },
    });

    await waitFor(() => expect(onSendFile).toHaveBeenCalledWith(file));
    view.unmount();
  });
});

describe("relay transfer limit feedback", () => {
  const baseProps = {
    items: [] as TransferItem[],
    onSendText: vi.fn(),
    onSendFile: vi.fn(),
    onSendFolder: vi.fn(),
    onDisconnect: vi.fn(),
    role: "host" as const,
    transportMode: "relay" as const,
  };

  it("shows a relay size hint but does not show it for direct P2P", () => {
    const relay = renderToStaticMarkup(
      React.createElement(TransferPanel, baseProps)
    );
    const p2p = renderToStaticMarkup(
      React.createElement(TransferPanel, { ...baseProps, transportMode: "p2p" })
    );
    expect(relay).toContain("Relay files up to 10 MB; images exempt");
    expect(p2p).not.toContain("Relay files up to");
    const turn = renderToStaticMarkup(
      React.createElement(TransferPanel, {
        ...baseProps,
        transportMode: "turn",
      })
    );
    expect(turn).toContain("TURN Relay");
    expect(turn).toContain("Relay files up to");
  });

  it("reports a pasted file's relay limit and still sends editor text", async () => {
    vi.mocked(toast.error).mockClear();
    const onSendFile = vi.fn().mockRejectedValue(new RelayLimitError());
    const onSendText = vi.fn();
    const view = render(
      React.createElement(TransferPanel, {
        ...baseProps,
        onSendFile,
        onSendText,
      })
    );
    const editor = view.container.querySelector("textarea")!;
    const file = new File(["file"], "large.zip");
    fireEvent.paste(editor, { clipboardData: { items: [], files: [file] } });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Relay transfer limited to 10 MB"
      )
    );
    fireEvent.change(editor, { target: { value: "Text is unrestricted" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSendText).toHaveBeenCalledWith("Text is unrestricted");
    view.unmount();
  });

  it("handles rejection from file selection without an unhandled promise", async () => {
    vi.mocked(toast.error).mockClear();
    const onSendFile = vi.fn().mockRejectedValue(new RelayLimitError());
    const view = render(
      React.createElement(TransferPanel, { ...baseProps, onSendFile })
    );
    const input = view.container.querySelector('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(["file"], "large.zip")] },
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Relay transfer limited to 10 MB"
      )
    );
    view.unmount();
  });
});
