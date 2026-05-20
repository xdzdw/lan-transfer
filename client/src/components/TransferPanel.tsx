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
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

interface TransferPanelProps {
  items: TransferItem[];
  onSendText: (text: string) => void;
  onSendFile: (file: File) => void;
  onDisconnect: () => void;
  role: "host" | "client";
  transportMode: TransportMode;
  isReconnecting?: boolean;
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

export function TransferPanel({ items, onSendText, onSendFile, onDisconnect, role, transportMode, isReconnecting }: TransferPanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  const handleSendText = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSendText(trimmed);
    setText("");
    textareaRef.current?.focus();
  }, [text, onSendText]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  }, [handleSendText]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach(file => onSendFile(file));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [onSendFile]);

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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      Array.from(files).forEach(file => onSendFile(file));
    }
  }, [onSendFile]);

  return (
    <div
      className="flex flex-col h-full relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
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
              <span className="text-sm font-medium text-primary">{t("dropToSend")}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reconnecting banner */}
      {isReconnecting && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
          <Loader2 className="size-3 animate-spin text-amber-600" />
          <span className="text-[11px] font-mono text-amber-700">{t("reconnectingHint")}</span>
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
            {role === "host" ? <Monitor className="size-3.5" /> : <Smartphone className="size-3.5" />}
            <ArrowLeftRight className="size-2.5" />
            {role === "host" ? <Smartphone className="size-3.5" /> : <Monitor className="size-3.5" />}
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {t("connected")}
          </span>
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
                <TransferItemRow item={item} />
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
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("typeMessage")}
              rows={1}
              className={cn(
                "w-full resize-none rounded-lg border border-input bg-muted/30 px-3 py-2.5 pr-10 text-sm",
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
            <button
              onClick={() => fileInputRef.current?.click()}
              className="absolute right-2.5 bottom-2.5 p-1 rounded hover:bg-muted transition-colors text-muted-foreground/50 hover:text-muted-foreground"
              title={t("attachFile")}
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
