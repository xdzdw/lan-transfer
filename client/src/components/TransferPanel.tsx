/**
 * TransferPanel — The main transfer interface shown after connection
 *
 * Design: Swiss Utility — clean vertical layout, text input at bottom,
 * file drop zone covers the entire panel, transfer history scrolls above.
 *
 * Now includes transport mode indicator (P2P / Relay / Upgrading)
 */

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TransferItemRow } from "@/components/TransferItemRow";
import { LangSwitch } from "@/components/LangSwitch";
import type { TransferItem } from "@/hooks/usePeerHost";
import type { TransportMode } from "@/lib/webrtc";
import { useI18n } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import {
  captureScreenshot,
  isScreenshotCaptureSupported,
  ScreenshotCaptureError,
} from "@/lib/screenshot";
import { ScreenshotRegionSelector } from "@/components/ScreenshotRegionSelector";
import {
  readClipboardFiles,
  readTransferItems,
  type FolderTransferFile,
} from "@/lib/folderTransfer";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUpFromLine,
  FileUp,
  Paperclip,
  Send,
  X,
  Monitor,
  Smartphone,
  ArrowLeftRight,
  Zap,
  Globe,
  Loader2,
  Camera,
  FolderOpen,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface TransferPanelProps {
  items: TransferItem[];
  onSendText: (text: string) => void;
  onSendFile: (
    file: File,
    options?: { isScreenshot?: boolean }
  ) => void | Promise<void>;
  onSendFolder: (files: FolderTransferFile[]) => void | Promise<void>;
  onDisconnect: () => void;
  role: "host" | "client";
  transportMode: TransportMode;
  isReconnecting?: boolean;
  /** The 4-digit room code (host only) — shown so the phone can rejoin */
  roomCode?: string;
}

export function scrollConversationToLatest(
  container: Pick<HTMLDivElement, "scrollHeight" | "scrollTo"> | null
) {
  if (!container) return;

  container.scrollTo({
    top: container.scrollHeight,
    behavior: "smooth",
  });
}

function TransportBadge({ mode }: { mode: TransportMode }) {
  const { t } = useI18n();

  if (mode === "upgrading") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-amber-500/10 text-amber-600 border border-amber-500/20">
        <Loader2 className="size-2.5 animate-spin" />
        {t("upgrading")}
      </span>
    );
  }

  if (mode === "p2p") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
        <Zap className="size-2.5" />
        P2P
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-blue-500/10 text-blue-600 border border-blue-500/20">
      <Globe className="size-2.5" />
      {t("relay")}
    </span>
  );
}

export function TransferPanel({
  items,
  onSendText,
  onSendFile,
  onSendFolder,
  onDisconnect,
  role,
  transportMode,
  isReconnecting,
  roomCode,
}: TransferPanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [pendingScreenshot, setPendingScreenshot] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  // Keep the newest conversation item visible whenever a new item arrives.
  useEffect(() => {
    scrollConversationToLatest(scrollRef.current);
  }, [items.length]);

  const handleSendText = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSendText(trimmed);
    setText("");
    textareaRef.current?.focus();
  }, [text, onSendText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendText();
      }
    },
    [handleSendText]
  );

  const handleCaptureScreenshot = useCallback(async () => {
    if (!isScreenshotCaptureSupported()) {
      toast.error(t("screenshotUnsupported"));
      return;
    }

    setIsCapturingScreenshot(true);
    try {
      const screenshot = await captureScreenshot();
      setPendingScreenshot(screenshot);
    } catch (error) {
      if (
        error instanceof ScreenshotCaptureError &&
        error.code === "cancelled"
      ) {
        toast.info(t("screenshotCancelled"));
      } else if (
        error instanceof ScreenshotCaptureError &&
        error.code === "black"
      ) {
        toast.error(t("screenshotBlackFrame"));
      } else {
        toast.error(t("screenshotFailed"));
      }
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [onSendFile, t]);

  const handleScreenshotConfirm = useCallback(
    async (screenshot: File) => {
      try {
        await onSendFile(screenshot, { isScreenshot: true });
        toast.success(t("screenshotSent"));
      } catch {
        toast.error(t("screenshotFailed"));
      } finally {
        setPendingScreenshot(null);
        setIsCapturingScreenshot(false);
      }
    },
    [onSendFile, t]
  );

  const handleScreenshotCancel = useCallback(() => {
    setPendingScreenshot(null);
    setIsCapturingScreenshot(false);
    toast.info(t("screenshotCancelled"));
  }, [t]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files)
        void Promise.all(Array.from(files).map(file => onSendFile(file)));
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [onSendFile]
  );

  const handleFolderSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) {
        const entries = Array.from(files).map(file => ({
          file,
          relativePath:
            (file as File & { webkitRelativePath?: string })
              .webkitRelativePath || file.name,
        }));
        void onSendFolder(entries);
      }
      if (folderInputRef.current) folderInputRef.current.value = "";
    },
    [onSendFolder]
  );

  const sendTransferEntries = useCallback(
    async (entries: FolderTransferFile[]) => {
      if (entries.length === 0) return;
      const isFolder = entries.some(entry => entry.relativePath.includes("/"));
      if (isFolder) {
        const groups = new Map<string, FolderTransferFile[]>();
        for (const entry of entries) {
          const root = entry.relativePath.split("/")[0] || entry.file.name;
          const group = groups.get(root) || [];
          group.push(entry);
          groups.set(root, group);
        }
        for (const group of Array.from(groups.values()))
          await onSendFolder(group);
        return;
      }
      for (const entry of entries) await onSendFile(entry.file);
    },
    [onSendFile, onSendFolder]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);

      const entries = await readTransferItems(Array.from(e.dataTransfer.items));
      await sendTransferEntries(entries);
    },
    [sendTransferEntries]
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLElement>) => {
      const fileItems = Array.from(e.clipboardData.items).filter(
        item => item.kind === "file"
      );
      const clipboardFiles = Array.from(e.clipboardData.files || []);
      if (fileItems.length === 0 && clipboardFiles.length === 0) return;
      e.preventDefault();
      const itemEntries =
        fileItems.length > 0 ? await readTransferItems(fileItems) : [];
      let entries =
        itemEntries.length > 0
          ? itemEntries
          : clipboardFiles.map(file => ({
              file,
              relativePath: file.name || "pasted-file",
            }));
      if (entries.length === 0 && fileItems.length > 0) {
        entries = await readClipboardFiles();
      }
      await sendTransferEntries(entries);
    },
    [sendTransferEntries]
  );

  return (
    <div
      className="flex flex-col h-full relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {pendingScreenshot && (
        <ScreenshotRegionSelector
          file={pendingScreenshot}
          onConfirm={handleScreenshotConfirm}
          onCancel={handleScreenshotCancel}
        />
      )}

      {/* Drag overlay */}
      <AnimatePresence>
        {isDragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-background/95 border-2 border-dashed border-primary/40 rounded-lg"
          >
            <div className="flex flex-col items-center gap-3">
              <ArrowUpFromLine className="size-7 text-primary" />
              <span className="text-sm font-medium text-primary">
                {t("dropToSend")}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reconnecting banner */}
      {isReconnecting && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
          <Loader2 className="size-3 animate-spin text-amber-600" />
          <span className="text-[11px] font-mono text-amber-700">
            {t("reconnectingHint")}
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <span className="relative flex size-2">
            {isReconnecting ? (
              <span className="relative inline-flex size-2 rounded-full bg-amber-500 animate-pulse" />
            ) : (
              <>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/40" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </>
            )}
          </span>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {role === "host" ? (
              <Monitor className="size-3.5" />
            ) : (
              <Smartphone className="size-3.5" />
            )}
            <ArrowLeftRight className="size-2.5" />
            {role === "host" ? (
              <Smartphone className="size-3.5" />
            ) : (
              <Monitor className="size-3.5" />
            )}
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {t("connected")}
          </span>
          {roomCode && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-foreground/5 border border-foreground/10">
              <span className="text-[11px] font-mono font-bold tracking-[0.15em] text-foreground">
                {roomCode}
              </span>
            </span>
          )}
          <TransportBadge mode={transportMode} />
        </div>
        <div className="flex items-center gap-3">
          <LangSwitch />
          <button
            onClick={onDisconnect}
            className="text-[10px] font-mono text-muted-foreground/50 hover:text-destructive transition-colors flex items-center gap-1"
          >
            <X className="size-3" />
            {t("end")}
          </button>
        </div>
      </div>

      <Separator />

      {/* Transfer history */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-16 text-muted-foreground">
            <FileUp className="size-7 mb-4 opacity-30" />
            <p className="text-sm font-medium">{t("readyToTransfer")}</p>
            <p className="text-[11px] mt-1.5 text-muted-foreground/60">
              {role === "host" ? t("dragFilesHere") : t("sendTextOrAttach")}
            </p>
          </div>
        ) : (
          <div className="py-1">
            {items.map(item => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <TransferItemRow item={item} allItems={items} />
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Input area */}
      <div className="p-3 shrink-0 bg-background">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("typeMessage")}
              rows={1}
              className={cn(
                "w-full resize-none rounded-lg border border-input bg-muted/30 px-3 py-2.5 pr-20 text-sm",
                "placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:bg-transparent",
                "min-h-[42px] max-h-[120px] field-sizing-content transition-colors"
              )}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFolderSelect}
              {...({
                webkitdirectory: "",
                directory: "",
              } as React.InputHTMLAttributes<HTMLInputElement>)}
            />
            <button
              type="button"
              onClick={handleCaptureScreenshot}
              disabled={isCapturingScreenshot}
              className="absolute right-10 bottom-2.5 p-1 rounded hover:bg-muted disabled:opacity-50 transition-colors text-muted-foreground/50 hover:text-muted-foreground"
              title={t("captureScreenshot")}
              aria-label={t("captureScreenshot")}
            >
              {isCapturingScreenshot ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Camera className="size-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="absolute right-[4.5rem] bottom-2.5 p-1 rounded hover:bg-muted transition-colors text-muted-foreground/50 hover:text-muted-foreground"
              title={t("attachFolder")}
              aria-label={t("attachFolder")}
            >
              <FolderOpen className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute right-2.5 bottom-2.5 p-1 rounded hover:bg-muted transition-colors text-muted-foreground/50 hover:text-muted-foreground"
              title={t("attachFile")}
              aria-label={t("attachFile")}
            >
              <Paperclip className="size-4" />
            </button>
          </div>
          <Button
            size="icon"
            onClick={handleSendText}
            disabled={!text.trim()}
            className="shrink-0 size-[42px] rounded-lg"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
